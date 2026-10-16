/**
 * A frozen copy's identity. An approval, a pin and a verdict all name the
 * exact text by its hash, so a revision is the same bytes wherever it is read.
 *
 * A spec whose home is buildd hashes its text as stored. A home that
 * re-serializes on save (a wiki page's storage format) converts to Markdown
 * and normalizes first, so a save that changed nothing reads as the same
 * version rather than an edit nobody made.
 *
 * Uses Web Crypto, present in Bun, Node 18+, Workers and browsers.
 */

/** Lowercase hex SHA-256 of the UTF-8 text, exactly as given. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Markdown as an external home's frozen copy is hashed: Unicode NFC, LF line
 * ends, no trailing spaces, no non-breaking spaces, at most one blank line in
 * a row, and one final newline. Text inside fenced code keeps its spacing.
 */
export function normalizeFrozenCopy(markdown: string): string {
  const lines = markdown.normalize('NFC').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    const line = fenced ? raw.replace(/\s+$/, '') : raw.replace(/ /g, ' ').replace(/\s+$/, '');
    if (!fenced && line === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

/** The hash an external home's version is identified by. */
export const frozenCopyHash = (markdown: string): Promise<string> => contentHash(normalizeFrozenCopy(markdown));
