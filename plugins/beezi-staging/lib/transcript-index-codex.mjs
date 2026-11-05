import fs from 'fs';
import path from 'path';
import { codexSessionsDir } from './paths.mjs';
import { isUsableSessionId, listRolloutFiles, ROLLOUT_HEAD_BYTES } from './transcript-codex.mjs';
import { readRolloutHead, subagentIdentityFrom } from './subagent-codex.mjs';
import { rolloutIdFromName, rolloutContentSize, zstdSupported, isCompressedRolloutName, rolloutSupersedes } from './rollout-file.mjs';

// Enumerate every past TOP-LEVEL Codex session on this machine for the history backfill.
//
// Codex writes subagent rollouts as their own top-level files in the same date tree
// (`thread_source: "subagent"` in their session_meta), so a bare walk would surface each agent
// as a session of its own — and the parent's checkpoint sweep would then bill it a second time.
// The discriminator here is subagentIdentityFrom() on the first record: EXACTLY the check
// findSubagentRollouts trusts when claiming children, so parent and child classification can
// never disagree.
//
// The same single-record head read also yields the session id and launch cwd, so the audit
// never has to re-open the file for either.
//
// Everything is best-effort: an unreadable tree yields [], an unreadable entry is skipped —
// discovery must never break the backfill.

function contentSizeOf(file, fallback) {
  try { return rolloutContentSize(file); } catch { return fallback; }
}

// Reading a compressed rollout's head means decompressing, which is orders of magnitude dearer than
// a plain read (measured: ~400 compressed rollouts cost seconds per pass). A rollout's identity
// does not change while its path, mtime and size do not, and the index is walked several times per
// process (status, sync, the watcher's audit), so the derived answer is kept in-process. Only what
// the walk needs is kept, never the record: a session_meta can run to ~48KB.
const compressedHeads = new Map();

function headOf(full, stat, readHead) {
  const key = `${full}|${stat.mtimeMs}|${stat.size}`;
  const cached = compressedHeads.get(key);
  if (cached !== undefined) return cached;
  const [first] = readHead(full, { maxBytes: ROLLOUT_HEAD_BYTES, maxRecords: 1 });
  if (!first) return null;
  const meta = first.type === 'session_meta' ? first.payload : null;
  const head = {
    subagent: !!subagentIdentityFrom([first]),
    id: str((meta || {}).id),
    cwd: str((meta || {}).cwd),
  };
  if (isCompressedRolloutName(full) && readHead === readRolloutHead) compressedHeads.set(key, head);
  return head;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// List every importable top-level session, oldest-first so an interrupted import advances
// chronologically. Returns [{ sessionId, transcriptPath, cwd, mtimeMs, size }].
//
// Compressed rollouts (`.jsonl.zst`) are listed too, with `size` the DECOMPRESSED size. When the same id exists as both, the plain file wins whatever the
// mtimes say: a resume decompresses back to `.jsonl`, so a leftover `.zst` is the stale copy.
// On a Node that cannot decompress zstd the head is unreadable, so a compressed rollout is listed
// from its filename alone (`compressed: true`, no cwd) for runAudit to count and skip. Those
// blind entries are opt-in (`includeBlind`): their cwd and subagent status are unknown, so every
// other consumer (routing, past-session counts, pickers) must never see them.
// `readHead` and `decompress` (null: no zstd) are test seams.
export function listAllRollouts({ sessionsDir = null, readHead = readRolloutHead, includeBlind = false, decompress } = {}) {
  const root = sessionsDir === undefined || sessionsDir === null ? codexSessionsDir() : sessionsDir;
  const bySession = new Map();

  for (const full of listRolloutFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // One record is enough for all three answers: is it a subagent, what session is it, where
    // was it launched. ROLLOUT_HEAD_BYTES is the shared one-record window.
    const compressed = isCompressedRolloutName(full);
    const blind = compressed && !zstdSupported(decompress === undefined ? {} : { decompress });
    if (blind && !includeBlind) continue;
    let head = { subagent: false, id: null, cwd: null };
    if (!blind) {
      head = headOf(full, stat, readHead);
      if (!head || head.subagent) continue;
    }

    // `id`, never `session_id`: on a subagent rollout the latter holds the PARENT's thread id
    // (`subagentIdentityFrom` in lib/subagent-codex.mjs), and this entry names THIS file.
    //
    // Both sources are validated rather than merely non-empty. An id that is one of the strings
    // JavaScript makes from a missing value — `null`, `undefined` — is not a session: keyed on it,
    // every id-less rollout would import as one shared phantom session and accrete unrelated
    // segments. Skipping costs one unimportable file; accepting corrupts an account's numbers.
    const metaId = head.id;
    const nameId = rolloutIdFromName(path.basename(full));
    const sessionId = isUsableSessionId(metaId)
      ? metaId
      : (isUsableSessionId(nameId) ? nameId : null);
    if (!sessionId) continue;

    const entry = {
      sessionId,
      transcriptPath: full,
      cwd: head.cwd,
      mtimeMs: stat.mtimeMs,
      size: compressed ? contentSizeOf(full, stat.size) : stat.size,
    };
    if (blind) entry.compressed = true;

    // Codex resume can leave two rollouts carrying the same trailing session id. The ledger
    // dedupes only across runs, so without collapsing here one session would be parsed — and
    // billed — twice in a single run. Keep the newest file: a resumed rollout replays the
    // original's records, so it supersedes the older one.
    // A plain file beats a compressed one whatever the mtimes (rolloutSupersedes).
    const existing = bySession.get(sessionId);
    if (!existing || rolloutSupersedes(full, entry.mtimeMs, existing.transcriptPath, existing.mtimeMs)) {
      bySession.set(sessionId, entry);
    }
  }

  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}
