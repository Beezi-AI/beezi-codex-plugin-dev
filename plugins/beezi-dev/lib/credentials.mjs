import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { credentialsFile, environment, BEEZI_ENV } from './paths.mjs';
import { readJson, writeJsonDurable } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

// The OS keyring entry this plugin owns. On Windows it is the target name shown under Control
// Panel → Credential Manager → Windows Credentials, so it has to say which agent it belongs to:
// the Claude Code plugin keeps `beezi-analytics` on the same machine, and two agents sharing one
// entry would fight over refreshed tokens and over logout.
//
// The environment suffix (G-2-2) is the second half of that: `beezi-codex-staging` is a different
// Credential Manager target, a different keychain item and a different libsecret attribute set, so
// two installed variants never share a token. `envSuffix()` throws on unresolvable metadata, which
// is why a malformed variant env.json fails at THIS module's load rather than silently producing
// the production target name — and it is validated against `'' | dev | staging | local` before
// it reaches the PowerShell templates below, which interpolate SERVICE as literal script text.
export const SERVICE = `beezi-codex${environment.envSuffix()}`;

const ACCOUNT = 'token';

// The environment the stored credentials were issued under, persisted alongside them.
//
// SERVICE already keeps the native keyrings apart, but `BEEZI_CODEX_HOME` is an explicit FULL-ROOT
// override: a caller who points two environments at one root shares the file store between them. R1
// requires that a mismatched binding PREVENT UPLOAD rather than proceed, so a blob whose stamp
// disagrees with the resolved environment reads as "no credentials" — getAccessToken() then returns
// null and every reporting path has no bearer token to flush with. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// An UNSTAMPED blob is the pre-G-2-2 state, and there was exactly one namespace then: it reads as
// production, so existing unsuffixed installs keep working untouched and a staging build cannot
// adopt them. The stamp never leaves this module — it is added on write and removed on read, so
// every consumer of a credentials object sees the same shape it always did.
const ENV_STAMP = 'beezi_env';

function stampOf(obj) {
  const value = obj[ENV_STAMP];
  return typeof value === 'string' ? value : '';
}

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe`
// is resolved against the child's current directory first, so an attacker file dropped
// in a repo the user opens could be executed (and would receive the plaintext token on
// stdin). Pinning the system path closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout } so callers can fall back to the file store on any failure.
function defaultRun(file, args, input) {
  try {
    const stdout = execFileSync(file, args, {
      input: orDefault(input, undefined),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Bound the spawn: a locked keychain / hung helper must not block the hook.
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: orDefault(stdout, '') };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──

function fileRead() {
  return readJson(credentialsFile());
}

function fileWrite(obj) {
  writeJsonDurable(credentialsFile(), obj);
}

function fileDelete() {
  try { fs.unlinkSync(credentialsFile()); } catch { /* already absent */ }
}

// ── backends. Each: { available(), get() -> string|null, set(token) -> boolean, delete() }.

function macBackend(run, service = SERVICE) {
  return {
    available: () => true, // `security` ships with macOS
    get() {
      return tokenFrom(run('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w']));
    },
    set(token) {
      return run('security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', token]).ok
        ? 'the macOS keychain' : false;
    },
    delete() {
      run('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT]);
    },
  };
}

function secretToolBackend(run, service = SERVICE) {
  const attrs = ['service', service, 'account', ACCOUNT];
  return {
    available: () => run('secret-tool', ['--version']).ok, // libsecret often absent
    get() {
      return tokenFrom(run('secret-tool', ['lookup', ...attrs]));
    },
    set(token) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return run('secret-tool', ['store', `--label=${service}`, ...attrs], token).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete() {
      run('secret-tool', ['clear', ...attrs]);
    },
  };
}

// Windows: the primary store is the Credential Manager, reached via a P/Invoke to advapi32
// (CredWrite/CredRead/CredDelete) — the token then appears under Control Panel → Credential
// Manager → Windows Credentials, keyed by SERVICE. The `cmdkey` CLI can *store* but not read
// a secret back, so we call the Win32 API directly through PowerShell. Should that ever fail
// (locked-down box, PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the
// ciphertext kept in the 0600 file, and finally to a plaintext 0600 file.
const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

function powershell(run, script, input) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}

// ── Windows Credential Manager via advapi32 P/Invoke (the primary Windows store) ──
// The CREDENTIAL struct is shared by the read and write scripts. CharSet=Unicode marshals
// TargetName/UserName as wide strings; the secret blob is written/read as UTF-16 so it
// round-trips any character (verified against '&', '=', '.').
const CRED_STRUCT = `
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}`;

// Reads the secret from stdin (never an argv element, so it can't leak via the process list),
// writes a GENERIC credential with LOCAL_MACHINE persistence, prints 'OK' on success.
const CRED_WRITE = `$in=[Console]::In.ReadToEnd()
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredW {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL c, uint flags);${CRED_STRUCT}
}
"@
$bytes=[Text.Encoding]::Unicode.GetBytes($in)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object BeeziCredW+CREDENTIAL
$c.Type=1; $c.TargetName='${SERVICE}'; $c.UserName='${ACCOUNT}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero
// when the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const CRED_READ = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${SERVICE}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const CRED_DELETE = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${SERVICE}',1,0)`;

function credManBackend(run, service = SERVICE) {
  return {
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    get() {
      return tokenFrom(powershell(run, CRED_READ.split(SERVICE).join(service)));
    },
    set(token) {
      const r = powershell(run, CRED_WRITE.split(SERVICE).join(service), token);
      return r.ok && r.stdout.trim() === 'OK' ? 'the Windows Credential Manager' : false;
    },
    delete() {
      powershell(run, CRED_DELETE.split(SERVICE).join(service));
    },
  };
}

function dpapiFileBackend(run) {
  return {
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    get() {
      const obj = fileRead();
      if (!obj) return null;
      if (typeof obj.enc === 'string') return tokenFrom(powershell(run, DPAPI_DEC, obj.enc));
      return typeof obj.token === 'string' ? obj.token : null; // plaintext (DPAPI was down at set)
    },
    set(token) {
      const r = powershell(run, DPAPI_ENC, token);
      if (r.ok && r.stdout.trim()) { fileWrite({ enc: r.stdout.trim() }); return 'Windows DPAPI (encrypted at rest)'; }
      fileWrite({ token }); // DPAPI unavailable → plaintext, still 0600
      return 'a restricted local file';
    },
    delete: fileDelete,
  };
}

function fileBackend() {
  return {
    available: () => true,
    get() {
      const obj = fileRead();
      return obj && typeof obj.token === 'string' ? obj.token : null;
    },
    set(token) { fileWrite({ token }); return 'a restricted local file'; },
    delete: fileDelete,
  };
}

// Preferred backend chain for the platform; the plaintext file is always the tail.
function backends(deps) {
  const run = deps.run || defaultRun;
  const platform = deps.platform || process.platform;
  const file = { name: 'file', ...fileBackend() };
  if (platform === 'darwin') return [{ name: 'keychain', ...macBackend(run) }, file];
  if (platform === 'linux') return [{ name: 'secret-service', ...secretToolBackend(run) }, file];
  if (platform === 'win32') return [{ name: 'credman', ...credManBackend(run) }, { name: 'dpapi-file', ...dpapiFileBackend(run) }, file];
  return [file];
}

// The backends store an opaque string. Since the Clerk OAuth migration that
// string is a JSON credentials object: { client_id, redirect_uri,
// token_endpoint, access_token, refresh_token, expires_at }. Legacy bare
// device tokens fail to parse and read as "not linked".
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || typeof obj.access_token !== 'string') return null;
    // Bind credential SELECTION to the environment (R1). A stamp that disagrees is not a
    // recoverable state here — this preparatory release owns no migration — so it reads as
    // unlinked, which stops the upload instead of flushing one environment's queue with the
    // other's token.
    if (stampOf(obj) !== BEEZI_ENV) return null;
    const out = { ...obj };
    delete out[ENV_STAMP];
    return out;
  } catch {
    return null;
  }
}

const REVISION = Symbol('credential revision');
const controlFile = () => path.join(path.dirname(credentialsFile()), 'credential-control.json');

function unavailable(message, code = 'CREDENTIALS_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readControl() {
  let raw;
  try { raw = fs.readFileSync(controlFile(), 'utf-8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unavailable('Credential control record cannot be read');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw unavailable('Invalid credential control record'); }
  if (!value || value.version !== 1 || typeof value.revision !== 'string'
    || (value.backend !== null && typeof value.backend !== 'string')) {
    throw unavailable('Invalid credential control record');
  }
  return value;
}

export function credentialRevision(creds) {
  return creds && creds[REVISION] || null;
}

// Retry only an already committed OS store; fresh installs should not wait
// for an entry that does not exist. The environment guard requires sync reads.
function readCommittedCredential(backend, deps) {
  const read = () => backend.available() ? backend.get() : null;
  let raw = read();
  if (!['credman', 'keychain', 'secret-service'].includes(backend.name)) return raw;
  const sleep = deps.sleepImpl || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (const delay of [100, 250]) {
    if (raw) break;
    sleep(delay);
    raw = read();
  }
  return raw;
}

export async function getCredentials(deps = {}) {
  const control = readControl();
  if (control) {
    if (control.beezi_env !== BEEZI_ENV || control.backend === null) return null;
    const backend = backends(deps).find(b => b.name === control.backend);
    if (!backend) throw unavailable('Committed credential backend unavailable');
    const raw = readCommittedCredential(backend, deps);
    const creds = raw && parseCredentials(raw);
    if (!creds || creds.beezi_revision !== control.revision) {
      throw unavailable('Committed credentials temporarily unavailable');
    }
    delete creds.beezi_revision;
    Object.defineProperty(creds, REVISION, { value: control.revision });
    return creds;
  }
  // Existing installations are read in place until their first successful write. Thereafter
  // the control record selects one backend; an older fallback can never become authoritative.
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const raw = b.get();
    if (raw) return parseCredentials(raw);
  }
  return null;
}

// The one read-modify-write wrapper for the credential store: rank-4 `credential` lock, an
// optimistic revision check, and a fresh revision handed to the mutation.
function mutateCredentials(options, fn) {
  const result = withLock({ ...sharedLock('credentials'), kind: 'credential' }, { migrationPermit: options.migrationPermit }, lock => {
    const control = readControl();
    if ('expectedRevision' in options && options.expectedRevision !== (control && control.revision || null)) {
      throw unavailable('Credentials changed during refresh', 'CREDENTIALS_SUPERSEDED');
    }
    const revision = crypto.randomBytes(16).toString('hex');
    return fn(revision, lock);
  });
  if (!result.ok) throw unavailable('Credential store is busy');
  return result.value;
}

// Returns a human-readable description of where the credentials were actually stored, so the caller
// can report accurately (keychain vs a local file) instead of always claiming the keychain.
export async function setCredentials(creds, deps = {}, options = {}) {
  return mutateCredentials(options, (revision, lock) => {
    const raw = JSON.stringify({ ...creds, [ENV_STAMP]: BEEZI_ENV, beezi_revision: revision });
    for (const b of backends(deps)) {
      if (!b.available()) continue;
      const where = b.set(raw);
      if (!where) continue;
      if (!lock.verify().ok) throw unavailable('Credential lock was lost');
      writeJsonDurable(controlFile(), { version: 1, revision, backend: b.name, beezi_env: BEEZI_ENV });
      return where;
    }
    throw unavailable('No credential backend accepted the write');
  });
}

export async function deleteCredentials(deps = {}, options = {}) {
  return mutateCredentials(options, (revision) => {
    // A tombstone prevents stale native-store copies or delayed refreshes reviving a logout.
    writeJsonDurable(controlFile(), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
    for (const b of backends(deps)) {
      if (b.available()) { try { b.delete(); } catch { /* ignore */ } }
    }
  });
}


/**
 * The stored blob EXACTLY as a backend holds it — unparsed, unstamped, unfiltered.
 *
 * The one caller is lib/env-migration.mjs, and the reason it cannot use getCredentials() is the
 * ENV_STAMP filter above: a legacy blob reads as production there, which is the assumption the
 * migration exists to test rather than inherit. The control record is not consulted either — a
 * pre-cutover install predates it, and this is exactly the blob such an install would send.
 *
 * Synchronous, because the guard that calls it runs before anything else in a hook and has no
 * business awaiting. Every backend get() is synchronous already.
 */
export function readRawCredential(deps = {}) {
  const control = readControl();
  if (control) {
    if (control.backend === null) return null;
    const backend = backends(deps).find(b => b.name === control.backend);
    if (!backend) throw unavailable('Committed credential backend unavailable');
    const raw = readCommittedCredential(backend, deps);
    if (!raw) throw unavailable('Committed credentials could not be read; check access to the credential store and try again later');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw unavailable('Invalid committed credentials'); }
    if (!parsed || parsed.beezi_revision !== control.revision) throw unavailable('Credential revision mismatch');
    return raw;
  }
  for (const b of backends(deps)) {
    if (!b.available()) continue;
    const raw = b.get();
    if (raw) return raw;
  }
  return null;
}

/**
 * Clear the stored blob from every backend, reporting whether it is actually gone.
 *
 * deleteCredentials() is best-effort by design (logout must not fail because a keychain was
 * locked). The migration needs the stronger answer: a staging token left in the unsuffixed
 * keyring after the production cutover is adopted, unstamped, by the production build.
 *
 * It goes THROUGH mutateCredentials rather than around it: a native copy that a delayed refresh
 * could revive is the same hazard here as at logout, and the tombstone revision is what closes
 * it.
 */
export function deleteRawCredential(deps = {}) {
  try {
    mutateCredentials({ migrationPermit: deps.migrationPermit }, (revision) => {
      writeJsonDurable(controlFile(), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
      for (const b of backends(deps)) {
        if (b.available()) { try { b.delete(); } catch { /* try the rest, then verify */ } }
      }
    });
  } catch {
    return false;
  }
  for (const b of backends(deps)) {
    if (b.available() && b.get()) return false;
  }
  return true;
}

/** The keyring entry name for an environment. Status output only — never a path. */
export function serviceFor(env) {
  const suffix = env === undefined || env === null || env === '' ? '' : `-${env}`;
  return `beezi-codex${suffix}`;
}

// Destination credential and authority are committed together while both migration barriers
// are held. Native credentials never fall back to plaintext here.
export function preserveMigrationCredential(raw, destination, deps = {}) {
  const run = deps.run || defaultRun;
  const platform = deps.platform || process.platform;
  const revision = crypto.randomBytes(16).toString('hex');
  const token = JSON.stringify({ ...JSON.parse(raw), beezi_env: 'staging', beezi_revision: revision });
  const backend = platform === 'darwin' ? { name: 'keychain', ...macBackend(run, serviceFor('staging')) }
    : platform === 'linux' ? { name: 'secret-service', ...secretToolBackend(run, serviceFor('staging')) }
      : platform === 'win32' ? { name: 'credman', ...credManBackend(run, serviceFor('staging')) } : null;
  if (!backend || !backend.available() || !backend.set(token) || backend.get() !== token) {
    writeJsonDurable(path.join(destination, 'credential-control.json'), {
      version: 1, revision, backend: null, beezi_env: 'staging',
    });
    return false;
  }
  writeJsonDurable(path.join(destination, 'credential-control.json'), {
    version: 1, revision, backend: backend.name, beezi_env: 'staging',
  });
  return true;
}

export function tombstoneMigrationCredential(deps = {}) {
  return mutateCredentials({ migrationPermit: deps.migrationPermit }, revision => {
    writeJsonDurable(controlFile(), { version: 1, revision, backend: null, beezi_env: BEEZI_ENV });
    return readControl().backend === null;
  });
}
