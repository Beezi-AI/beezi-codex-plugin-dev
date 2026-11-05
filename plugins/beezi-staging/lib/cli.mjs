// The output helper every CLI entry point in scripts/ had its own copy of.
//
// It lives in lib/ rather than in one script importing another because scripts/ entry points are
// siblings: each is spawned directly by name (`node scripts/sync.mjs`), and none of them is the
// natural parent of the others.
//
// Kept apart from lib/friendly-error.mjs deliberately: that module CLASSIFIES an error into a
// sentence and is imported by lib/diagnostics.mjs, which must never print or exit. This one does
// exactly the printing and exiting a library must not.

// Print the ✗ line and stop. Never returns.
export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
