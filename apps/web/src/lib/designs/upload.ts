/**
 * Limits and type checks for an uploaded design. The HTML is untrusted: it is
 * measured and sniffed as text here, never parsed into a DOM or executed.
 */

/** Under the 4.5 MB request-body ceiling of the serverless runtime; a 3-screen export is ~130 KB. */
export const MAX_DESIGN_BYTES = 4 * 1024 * 1024;

/**
 * What the object is stored as. Not text/html: a browser given this object from
 * any origin renders it as inert text. A viewer that wants to run it does so in
 * a sandboxed frame on the storage origin (a response-content-type override on
 * a signed URL), never from buildd's own origin.
 */
export const DESIGN_STORED_CONTENT_TYPE = 'text/plain; charset=utf-8';

export type DesignHtmlResult = { ok: true; bytes: Buffer } | { ok: false; status: 400 | 413 | 415; error: string };

const HTML_SIGNATURE = /<(?:!doctype\s+html|html|head|body|div|section|main|svg)\b/i;

export function validateDesignHtml(html: unknown, declaredType?: string | null): DesignHtmlResult {
  if (declaredType) {
    const t = declaredType.split(';')[0]!.trim().toLowerCase();
    if (t && t !== 'text/html' && t !== 'application/json' && t !== 'text/plain') {
      return { ok: false, status: 415, error: `A design is one HTML file; ${t} is not accepted` };
    }
  }
  if (typeof html !== 'string' || html.length === 0) return { ok: false, status: 400, error: 'html is required: the text of one HTML export' };
  // Check before encoding so an oversized body never costs a second copy.
  if (html.length > MAX_DESIGN_BYTES) return { ok: false, status: 413, error: `Design exceeds ${MAX_DESIGN_BYTES / (1024 * 1024)} MB limit` };
  const bytes = Buffer.from(html, 'utf8');
  if (bytes.byteLength > MAX_DESIGN_BYTES) return { ok: false, status: 413, error: `Design exceeds ${MAX_DESIGN_BYTES / (1024 * 1024)} MB limit` };
  if (html.includes(String.fromCharCode(0)) || !HTML_SIGNATURE.test(html.slice(0, 64 * 1024))) {
    return { ok: false, status: 415, error: 'Not an HTML document: expected text containing HTML markup' };
  }
  return { ok: true, bytes };
}
