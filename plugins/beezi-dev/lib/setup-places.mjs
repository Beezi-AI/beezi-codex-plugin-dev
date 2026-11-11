import { createRouteContext, routeForDir, routeKeyForDir } from './workspace-rules.mjs';

// The setup listing's places and the consented upload's sessions, both from the same eligible past sessions.

// A match or label holding a control character could forge a machine line, so listings leave such a place out.
export const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A " <word>=" inside a match or label reads as a field of the T line, so the setup leaves such a place out too.
const FIELD_LIKE = / [\w-]+=/;

const printable = (text) => !UNSAFE_LINE.test(text) && !FIELD_LIKE.test(text);

// Listed sessions with a folder whose place prints safely, with their place keys; noFolder counts those with no folder.
function eligibleSessions(listed, ctx) {
  const sessions = [];
  let noFolder = 0;
  for (const session of listed) {
    const key = typeof session.cwd === 'string' && session.cwd !== '' ? routeKeyForDir(session.cwd, ctx) : null;
    if (key == null) noFolder += 1;
    else if (printable(key.match) && printable(key.label)) sessions.push({ session, key });
  }
  return { sessions, noFolder };
}

const outsideLast = (place) => (place.kind === 'outside' ? 1 : 0);

function byListOrder(a, b) {
  return outsideLast(a) - outsideLast(b) || b.sessions - a.sessions || (a.label < b.label ? -1 : Number(a.label > b.label));
}

const sameTargets = (a, b) => (a === null || b === null ? a === b : a.slice().sort().join(',') === b.slice().sort().join(','));

// Places of the counted eligible sessions, most first, outside last; `tracked` is null without a rule or when its sessions route differently.
export function setupPlaces(row, counted) {
  const byId = new Map();
  counted.forEach((c) => c.listed.forEach((s) => byId.set(s.sessionId, s)));
  const ctx = createRouteContext();
  const found = eligibleSessions(Array.from(byId.values()), ctx);
  const byKey = new Map();
  for (const { session, key } of found.sessions) {
    const id = `${key.kind}\n${key.match}`;
    const rule = routeForDir(row, session.cwd, ctx);
    const tracked = rule == null ? null : rule.tenantIds;
    let place = byKey.get(id);
    if (place == null) {
      place = { kind: key.kind, match: key.match, label: key.label, sessions: 0, tracked, mixed: false };
      byKey.set(id, place);
    }
    if (!sameTargets(place.tracked, tracked)) place.mixed = true;
    place.sessions += 1;
  }
  const places = Array.from(byKey.values()).map((p) => ({
    kind: p.kind, match: p.match, label: p.label, sessions: p.sessions, tracked: p.mixed ? null : p.tracked,
  }));
  return {
    places: places.sort(byListOrder),
    sessions: found.sessions.length,
    ids: found.sessions.map((s) => s.session.sessionId),
    firstMs: Math.min.apply(null, found.sessions.map((s) => s.session.startedMs)),
    lastMs: Math.max.apply(null, found.sessions.map((s) => s.session.mtimeMs)),
    noFolder: found.noFolder,
  };
}

// The eligible sessions of one workspace's list the consented upload may owe it: none whose place's rule leaves it out.
export function consentedIds(row, tenantId, listed) {
  const ctx = createRouteContext();
  return eligibleSessions(listed, ctx).sessions
    .filter(({ session }) => {
      const rule = routeForDir(row, session.cwd, ctx);
      return rule == null || rule.tenantIds.indexOf(tenantId) !== -1;
    })
    .map(({ session }) => session.sessionId);
}
