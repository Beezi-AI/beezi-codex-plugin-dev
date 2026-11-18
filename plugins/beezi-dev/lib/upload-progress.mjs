import path from 'path';
import { stateDir, environment, naming } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// One record per account and workspace upload, written by the worker and followed by setup,
// "Upload now" and the next session start.
const LIVE_MS = 120000;
const RECORD_EXT = '.json';

function progressDir() {
  return path.join(stateDir(), 'upload-progress');
}

// Throws on a key that is not an account key; the tenant id is tagged so it cannot leave the folder.
export function progressPath(key, tenantId) {
  return path.join(progressDir(), `${environment.assertAccountKey(key)}-${naming.tenantTag(tenantId)}${RECORD_EXT}`);
}

export function createProgressWriter({ key, tenantId, workspace, now = Date.now, throttleMs = 1000 }) {
  let startedAt = null;
  let lastWriteMs = -Infinity;
  const write = (nowMs, { processed, total, sent }, finished, failed) => {
    const at = new Date(nowMs).toISOString();
    if (startedAt === null) startedAt = at;
    lastWriteMs = nowMs;
    const record = {
      key, tenantId, workspace, processed, total, sent,
      startedAt, updatedAt: at, finishedAt: finished ? at : null, reported: false,
    };
    // A missing field reads as false: only a run that did not end clean writes it.
    if (failed) record.failed = true;
    // Progress is best effort: a bad key or a failed write must never fail the upload.
    try { writeJsonSecure(progressPath(key, tenantId), record); } catch { /* next write retries */ }
  };
  return {
    update(counts) {
      const nowMs = now();
      if (nowMs - lastWriteMs >= throttleMs) write(nowMs, counts, false, false);
    },
    // `failed`: the run did not end clean, so followers show no done line for it.
    finish(counts, failed = false) {
      write(now(), counts, true, failed);
    },
  };
}

function readRecord(file) {
  const record = readJson(file);
  return record !== null && typeof record === 'object' ? record : null;
}

// A reader must never fail session start: a key that is not an account key has no record.
export function readProgress(key, tenantId) {
  let file;
  try { file = progressPath(key, tenantId); } catch { return null; }
  return readRecord(file);
}

export function isLive(record, nowMs) {
  return record !== null && record.finishedAt === null && nowMs - Date.parse(record.updatedAt) <= LIVE_MS;
}

export function markReported(key, tenantId) {
  const record = readProgress(key, tenantId);
  if (record !== null) writeJsonSecure(progressPath(key, tenantId), { ...record, reported: true });
}
