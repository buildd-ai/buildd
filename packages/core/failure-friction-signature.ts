/**
 * Bridge between worker-failure signatures and the friction-dedupe key space.
 *
 * `normalizeErrorSignature` in the failure-analytics lib produces readable
 * prose ("Stale worker expired (no update for <n>+ minutes)"). The friction
 * dedupe path in POST /api/tasks keys on `context.frictionSignature`, which
 * `subject-anchor-extractor.normalizeErrorSignature` only accepts as a known
 * pattern slug or a `namespace:slug` pair — free-form prose is rejected and the
 * task files as a duplicate.
 *
 * This module converts one into the other, so an agent that learns "this error
 * is already known" can hand the same key straight back to `create_task` and
 * have its report append to the existing friction task.
 *
 * Read-only and pure: a string in, a string out.
 */

/** Namespace for keys derived from aggregated worker failures. */
export const FRICTION_SIGNATURE_NAMESPACE = 'worker-failure';

/** Readable stem length. Kept short so the whole key stays greppable. */
const STEM_MAX = 40;
/** Hex digits of the disambiguating hash appended to every stem. */
const HASH_LEN = 6;

/**
 * FNV-1a, 32-bit. Chosen over a crypto hash because this key is a dedupe
 * discriminator, not a security boundary, and it must be computable in the
 * runner, the API route, and the MCP layer without a shared crypto import.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-HASH_LEN);
}

/**
 * Convert a normalized failure signature into a dedupe-safe friction key.
 *
 * The stem is a truncated snake_case rendering of the signature, so a human
 * reading a task's `context.frictionSignature` can tell what it refers to. The
 * hash suffix is computed over the FULL signature, so two failures that share a
 * 40-character prefix still get distinct keys — truncation alone would silently
 * merge unrelated failure families into one friction task.
 *
 *   "Stale worker expired (no update for <n>+ minutes)"
 *     → "worker-failure:stale_worker_expired_no_update_for_n_min_1a2b3c"
 */
export function toFrictionSignature(normalizedSignature: string): string {
  const source = typeof normalizedSignature === 'string' ? normalizedSignature : '';
  const hash = fnv1a(source);

  const stem = source
    .toLowerCase()
    // Everything outside [a-z0-9] collapses to one underscore. Placeholders
    // like `<n>` therefore survive as `n`, which reads fine in a key.
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, STEM_MAX)
    .replace(/_+$/g, '');

  return `${FRICTION_SIGNATURE_NAMESPACE}:${stem || 'unknown'}_${hash}`;
}
