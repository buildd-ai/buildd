/**
 * The body a keyed re-create (upsert by workspace + key) writes. A caller that
 * sends no `content` (re-titling, refreshing metadata, re-attaching a file) keeps
 * the stored body; it used to be wiped. An explicit `null` or `""` still clears it.
 */
export function upsertedContent(existing: string | null, sent: unknown): string | null {
  if (sent === undefined) return existing;
  return typeof sent === 'string' && sent ? sent : null;
}
