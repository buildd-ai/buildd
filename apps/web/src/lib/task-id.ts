/** Full UUID v4 regex (36-char, dashes in right places) */
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Zero-padded pattern — the known production regression:
 * real ID `bf442fcb-6179-43b3-aa92-2564b1ad24b8` gets mangled to
 * `bf442fcb-0000-0000-0000-000000000000`.
 */
const ZERO_PADDED_RE = /^[0-9a-f]{8}-0{4}-0{4}-0{4}-0{12}$/i;

/**
 * Returns true iff `id` is a well-formed, non-zero-padded UUID that is safe
 * to embed in a `/app/tasks/${id}` navigation link.
 *
 * Use this before constructing ANY task href to avoid silent 404s.
 */
export function isValidTaskId(id: string | null | undefined): id is string {
  if (!id) return false;
  if (!FULL_UUID_RE.test(id)) return false;
  if (ZERO_PADDED_RE.test(id)) return false;
  return true;
}
