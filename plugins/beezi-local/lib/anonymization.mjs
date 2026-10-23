import { oneLine } from './compat.mjs';
import { KINDS, Kind, PRIVATE_MARK, anonymizeReport } from './anonymize.mjs';

export { PRIVATE_MARK };

export const ANONYMIZATION_KEY_MISSING = 'anonymization-key-missing';
export const PastSessionsChoice = Object.freeze({ OFFER: 'offer', SKIP: 'skip' });

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const PAST_CHOICES = Object.values(PastSessionsChoice);
const neverAsked = () => ({ choice: PastSessionsChoice.OFFER, changedAt: null });

export const isId = (id) => typeof id === 'string' && id !== '';

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const allKinds = (on) => KINDS.reduce((out, kind) => ({ ...out, [kind]: on }), {});
const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const kindsAt = (map, id) => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : []);

// Any missing or non-boolean kind makes the whole block read as all five on.
function parseKinds(raw) {
  const kinds = isObject(raw) ? raw.kinds : null;
  if (!isObject(kinds) || !KINDS.every((kind) => typeof kinds[kind] === 'boolean')) return allKinds(true);
  return KINDS.reduce((out, kind) => ({ ...out, [kind]: kinds[kind] }), {});
}

function parsePastSessions(raw) {
  if (!isObject(raw) || PAST_CHOICES.indexOf(raw.choice) === -1) return neverAsked();
  return { choice: raw.choice, changedAt: isoOrNull(raw.changedAt) };
}

export function parseAnonymization(rawAnon, tenantId, rawPast) {
  if (rawAnon == null && rawPast == null) return null;
  const fields = isObject(rawAnon) ? rawAnon : {};
  return {
    tenantId: typeof tenantId === 'string' ? tenantId : null,
    kinds: rawAnon != null ? parseKinds(rawAnon) : allKinds(false),
    key: typeof fields.key === 'string' && KEY_PATTERN.test(fields.key) ? fields.key : null,
    machineName: oneLine(fields.machineName),
    pastSessions: parsePastSessions(rawPast),
  };
}

export function kindsOf(block) {
  if (block == null) return [];
  const kinds = parseKinds(block);
  return KINDS.filter((kind) => kinds[kind]);
}

export function hasKind(block, kind) {
  return kindsOf(block).indexOf(kind) !== -1;
}

export function pastSessionsOf(block) {
  return block != null && isObject(block.pastSessions) ? block.pastSessions : neverAsked();
}

export function isLaterChange(current, stored) {
  if (isoOrNull(current) == null) return false;
  return stored == null || Date.parse(current) > Date.parse(stored);
}

function blockOf(holder) {
  return holder != null && holder.anonymization != null ? holder.anonymization : null;
}

// The entry's own block, else the top-level block when it describes the same tenant.
function blockFor(session, entry, tenantId) {
  const own = blockOf(entry);
  if (own != null) return own;
  const top = blockOf(session);
  return top != null && top.tenantId === tenantId ? top : null;
}

export function anonymizationFor(session, tenantId) {
  if (session == null) return null;
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  if (tenantId != null) return blockFor(session, tenants.find((t) => t != null && t.id === tenantId), tenantId);
  if (tenants.length !== 1) return blockOf(session);
  return tenants[0] != null ? blockFor(session, tenants[0], tenants[0].id) : null;
}

export function sessionAnonymization(session) {
  if (session == null) return null;
  return anonymizationFor(session, isId(session.tenantId) ? session.tenantId : null);
}

// A headerless target resolves to its block's tenant, else the account's only workspace, else null.
function targetId(session, tenantId, block) {
  if (tenantId != null) return tenantId;
  if (block != null && isId(block.tenantId)) return block.tenantId;
  const tenants = session != null && Array.isArray(session.tenants) ? session.tenants : [];
  return tenants.length === 1 && tenants[0] != null && isId(tenants[0].id) ? tenants[0].id : null;
}

export function unionKinds(a, b) {
  return KINDS.filter((kind) => a.indexOf(kind) !== -1 || b.indexOf(kind) !== -1);
}

// A legacy array of ids reads as all five kinds for each id; unknown ids and kinds are dropped.
function normalizeMarker(marker) {
  const out = {};
  if (Array.isArray(marker)) {
    for (const id of marker) if (isId(id)) out[id] = KINDS.slice();
    return out;
  }
  if (!isObject(marker)) return out;
  for (const id of Object.keys(marker)) {
    const kinds = Array.isArray(marker[id]) ? unionKinds(marker[id], []) : [];
    if (isId(id) && kinds.length > 0) out[id] = kinds;
  }
  return out;
}

function addKinds(map, id, kinds) {
  if (isId(id) && kinds.length > 0) map[id] = unionKinds(kindsAt(map, id), kinds);
}

export function privateKinds(plans) {
  const map = {};
  for (const plan of plans) {
    for (const tenantId of [...plan.targets, ...plan.hold]) {
      const block = anonymizationFor(plan.session, tenantId);
      addKinds(map, targetId(plan.session, tenantId, block), kindsOf(block));
    }
  }
  return map;
}

export function hidesSessions(plans) {
  return plans.some((plan) => [...plan.targets, ...plan.hold]
    .some((tenantId) => hasKind(anonymizationFor(plan.session, tenantId), Kind.SESSIONS)));
}

export function markPrivate(payload, map) {
  const { [PRIVATE_MARK]: marker, ...rest } = payload;
  const union = normalizeMarker(marker);
  const added = normalizeMarker(map);
  for (const id of Object.keys(added)) addKinds(union, id, added[id]);
  return Object.keys(union).length > 0 ? { ...rest, [PRIVATE_MARK]: union } : rest;
}

export function withoutMarker(payload) {
  const { [PRIVATE_MARK]: marker, ...rest } = payload;
  return rest;
}

// An unresolved headerless target takes every marker entry.
function markedKinds(payload, id) {
  const marker = normalizeMarker(payload[PRIVATE_MARK]);
  if (id != null) return kindsAt(marker, id);
  return Object.keys(marker).reduce((out, each) => unionKinds(out, marker[each]), []);
}

export function wireKinds(payload, session, tenantId) {
  const block = anonymizationFor(session, tenantId);
  return unionKinds(markedKinds(payload, targetId(session, tenantId, block)), kindsOf(block));
}

export function reportForWire(payload, session, tenantId) {
  const kinds = wireKinds(payload, session, tenantId);
  if (kinds.length === 0) return withoutMarker(payload);
  const block = anonymizationFor(session, tenantId);
  return block != null && block.key != null ? anonymizeReport(payload, block.key, kinds) : null;
}

// `session` with `kinds` also hidden for its workspace; a history upload keeps hiding what was hidden at the yes (K4).
export function withKinds(session, kinds) {
  const block = sessionAnonymization(session);
  const current = kindsOf(block);
  const merged = unionKinds(current, Array.isArray(kinds) ? kinds : []);
  if (merged.length === current.length) return session;
  const tenantId = isId(session.tenantId) ? session.tenantId : null;
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  const entry = tenantId != null ? tenants.find((t) => t != null && t.id === tenantId) : (tenants.length === 1 ? tenants[0] : null);
  const next = {
    tenantId: entry == null ? tenantId : entry.id,
    key: null,
    machineName: null,
    ...(block == null ? {} : block),
    kinds: KINDS.reduce((out, kind) => ({ ...out, [kind]: merged.indexOf(kind) !== -1 }), {}),
  };
  // Where anonymizationFor looks first: the workspace's own entry, else the top-level block.
  if (entry == null) return { ...session, anonymization: next };
  return { ...session, tenants: tenants.map((t) => (t === entry ? { ...t, anonymization: next } : t)) };
}
