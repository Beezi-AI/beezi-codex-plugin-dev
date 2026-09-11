import fs from 'fs';

// Helpers that stand in for syntax and APIs newer than Node 13.2, the plugin's runtime floor
// (first Node with unflagged ESM). Everything in lib/ and scripts/ must stay parseable and
// runnable there; test/ is exempt and runs on modern Node. The floor is enforced by
// test/compat-syntax.test.mjs.

// `a ?? b` for the plain-defaulting case. The fallback is evaluated eagerly — where the
// right-hand side is expensive or has side effects, write the ternary out at the call site.
export function orDefault(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

// Buffer's 'base64url' encoding is Node 15.7+. PKCE (RFC 7636) requires the unpadded alphabet,
// so the trailing '=' strip is load-bearing, not cosmetic.
export function base64urlEncode(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Node's base64 decoder ignores missing padding, matching the tolerance of the native
// 'base64url' decoding this replaces.
export function base64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// fs.rmSync is Node 14.14+. These two cover every deletion the plugin performs: a single file
// that may already be gone, and a directory tree that may already be gone.
export function removeFileSync(p) {
  try {
    fs.unlinkSync(p);
  } catch { /* already gone */ }
}

export function removeDirSync(p) {
  try {
    if (fs.rmSync) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      // Node < 14.14: recursive rmdirSync exists since 12.10 and is not yet deprecated there.
      fs.rmdirSync(p, { recursive: true });
    }
  } catch { /* already gone */ }
}
