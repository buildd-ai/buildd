/**
 * The named screens of a design (Living Spec f43b6a61 R-2). A screen is an id,
 * a name and the viewport it was drawn at. Pure and string-only: a design's HTML
 * is untrusted, so nothing here evaluates it. It is read as text.
 */
export interface DesignScreen { id: string; name: string; viewport: string }
export type ScreensResult = { ok: true; screens: DesignScreen[] } | { ok: false; field: string; message: string };

export const MAX_SCREENS = 100;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const VIEWPORT_RE = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/;
const refuse = (field: string, message: string): ScreensResult => ({ ok: false, field, message });

/** Validate a screen list from a caller. A refusal names the field that is wrong. */
export function parseScreens(raw: unknown): ScreensResult {
  if (!Array.isArray(raw) || raw.length === 0) return refuse('screens', 'screens must be a non-empty list of { id, name, viewport }');
  if (raw.length > MAX_SCREENS) return refuse('screens', `a design holds at most ${MAX_SCREENS} screens`);
  const seen = new Set<string>();
  const screens: DesignScreen[] = [];
  for (const [i, s] of raw.entries()) {
    const at = `screens[${i}]`;
    if (!s || typeof s !== 'object') return refuse('screens', `${at} must be an object with id, name and viewport`);
    const { id, name, viewport } = s as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id)) return refuse('id', `${at}.id must be 1-64 letters, digits, "-" or "_" (got ${JSON.stringify(id)})`);
    if (seen.has(id)) return refuse('id', `${at}.id "${id}" is used twice; screen ids are unique within a design`);
    seen.add(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return refuse('name', `${at}.name must be 1-120 characters`);
    if (typeof viewport !== 'string' || !VIEWPORT_RE.test(viewport)) return refuse('viewport', `${at}.viewport must be WIDTHxHEIGHT in pixels, like 1440x900 (got ${JSON.stringify(viewport)})`);
    screens.push({ id, name, viewport });
  }
  return { ok: true, screens };
}

const TAG_RE = /<[a-z][a-z0-9-]*\s[^<>]{0,4000}>/gi;
const attr = (tag: string, name: string): string | null =>
  new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find(v => v !== undefined) ?? null;

/** Drop comments and script/style bodies so markers inside them are not screens. */
function markup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
}

/**
 * The screens a design export declares: elements carrying `data-screen="<id>"`,
 * with `data-screen-name` and `data-viewport="WxH"` (or `data-width` and
 * `data-height`). Only attributes are read; no markup is built or run.
 */
export function extractScreens(html: string): ScreensResult {
  const found: unknown[] = [];
  for (const tag of markup(html).match(TAG_RE) ?? []) {
    const id = attr(tag, 'data-screen');
    if (id === null) continue;
    const w = attr(tag, 'data-width'); const h = attr(tag, 'data-height');
    found.push({ id, name: attr(tag, 'data-screen-name') ?? id, viewport: attr(tag, 'data-viewport') ?? (w && h ? `${w}x${h}` : undefined) });
  }
  if (found.length === 0) return refuse('screens', 'no screens found: mark each one with data-screen="<id>" and data-viewport="WxH", or pass screens explicitly');
  return parseScreens(found);
}
