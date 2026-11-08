import { DESCRIPTION_PREFIX, REF_PREFIX } from "./definition.mjs";

const API = "https://api.cloudflare.com/client/v4";
const SERVER_FIELDS = ["last_updated", "version", "categories"];

export const isManaged = (rule) =>
  String(rule.ref ?? "").startsWith(REF_PREFIX) ||
  String(rule.description ?? "").startsWith(DESCRIPTION_PREFIX);

async function call(fetchImpl, credential, method, path, body) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

const entrypoint = (zoneId, phase) => `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${phase}/entrypoint`;

function failure(action, { status, payload }) {
  const detail = (payload.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
  return new Error(`${action} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
}

export async function fetchRules({ fetchImpl, credential, zoneId, phase }) {
  const res = await call(fetchImpl, credential, "GET", entrypoint(zoneId, phase));
  if (res.status === 404) return [];
  if (res.status !== 200 || !res.payload.success) throw failure(`reading ${phase}`, res);
  return res.payload.result?.rules ?? [];
}

export async function putRules({ fetchImpl, credential, zoneId, phase, rules }) {
  const res = await call(fetchImpl, credential, "PUT", entrypoint(zoneId, phase), { rules });
  if (res.status !== 200 || !res.payload.success) throw failure(`writing ${phase}`, res);
}

const isObject = (v) => v !== null && typeof v === "object";

/** True when every field of `wanted` is present in `actual`; the API adds defaults of its own. */
export function covers(actual, wanted) {
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && actual.length === wanted.length && wanted.every((w, i) => covers(actual[i], w));
  }
  if (isObject(wanted)) return isObject(actual) && Object.keys(wanted).every((k) => covers(actual[k], wanted[k]));
  return actual === wanted;
}

const clean = (rule) => {
  const out = { ...rule };
  for (const f of SERVER_FIELDS) delete out[f];
  return out;
};

/**
 * Merges the managed rules into what the zone has. Unmanaged rules keep their place and
 * content; managed rules we no longer define are dropped.
 */
export function mergeRules({ current, desired, disable = [] }) {
  const unmanaged = current.filter((r) => !isManaged(r)).map(clean);
  const managed = desired.map((r) => (disable.includes(r.ref) ? { ...r, enabled: false } : r));
  const currentManaged = new Map(current.filter(isManaged).map((r) => [r.ref, r]));
  const changes = [];
  for (const rule of managed) {
    const existing = currentManaged.get(rule.ref);
    if (!existing) changes.push({ kind: "add", ref: rule.ref, rule });
    else if (!covers(existing, rule)) changes.push({ kind: "change", ref: rule.ref, before: clean(existing), rule });
    else changes.push({ kind: "unchanged", ref: rule.ref });
    currentManaged.delete(rule.ref);
  }
  for (const [ref, rule] of currentManaged) changes.push({ kind: "remove", ref, before: clean(rule) });
  return { rules: [...managed, ...unmanaged], changes, unmanaged: unmanaged.length };
}

export async function planPhase({ fetchImpl, credential, zoneId, phase, desired, disable }) {
  const current = await fetchRules({ fetchImpl, credential, zoneId, phase });
  const merged = mergeRules({ current, desired, disable });
  const dirty = merged.changes.some((c) => c.kind !== "unchanged");
  return { phase, ...merged, dirty };
}

export async function applyPhase({ fetchImpl, credential, zoneId, phase, desired, disable }) {
  const planned = await planPhase({ fetchImpl, credential, zoneId, phase, desired, disable });
  if (planned.dirty) await putRules({ fetchImpl, credential, zoneId, phase, rules: planned.rules });
  return planned;
}
