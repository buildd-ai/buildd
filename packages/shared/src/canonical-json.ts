/**
 * Deterministic JSON — the one definition for the monorepo.
 *
 * Object keys sorted at every depth, array order kept, `undefined` object
 * fields dropped, `undefined`/`NaN`/`Infinity` rendered as `null` like
 * JSON.stringify does. Stored approval-input hashes are sha256 of this
 * string, so its output must never change; `__tests__/canonical-json.test.ts`
 * pins golden strings and hashes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
