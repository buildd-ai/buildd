import { DESIGN_SCREEN_KINDS, isDesignScreenKind, isRepoPath, type DesignScreenKind } from '@buildd/shared';

/**
 * The named screens of a design (Living Spec f43b6a61 R-2). A screen is an id,
 * a name and the viewport it was drawn at, and (R-14) optionally what it
 * specifies: `kind` component or page (page when absent) and `code`, the repo
 * path of the component. Pure and string-only: a design's HTML is untrusted, so
 * nothing here evaluates it. It is read as text.
 */
export interface DesignScreen { id: string; name: string; viewport: string; kind?: DesignScreenKind; code?: string }
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
    const { id, name, viewport, kind, code } = s as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id)) return refuse('id', `${at}.id must be 1-64 letters, digits, "-" or "_" (got ${JSON.stringify(id)})`);
    if (seen.has(id)) return refuse('id', `${at}.id "${id}" is used twice; screen ids are unique within a design`);
    seen.add(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return refuse('name', `${at}.name must be 1-120 characters`);
    if (typeof viewport !== 'string' || !VIEWPORT_RE.test(viewport)) return refuse('viewport', `${at}.viewport must be WIDTHxHEIGHT in pixels, like 1440x900 (got ${JSON.stringify(viewport)})`);
    if (kind !== undefined && !isDesignScreenKind(kind)) return refuse('kind', `${at}.kind must be one of ${DESIGN_SCREEN_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
    if (code !== undefined && !isRepoPath(code)) return refuse('code', `${at}.code must be a repo-relative file path, like apps/web/src/components/Row.tsx (got ${JSON.stringify(code)})`);
    screens.push({ id, name, ...(kind !== undefined ? { kind } : {}), ...(code !== undefined ? { code } : {}), viewport });
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
 * `data-height`), and optionally `data-kind` and `data-code`. Only attributes
 * are read; no markup is built or run.
 */
export function extractScreens(html: string): ScreensResult {
  const found: unknown[] = [];
  for (const tag of markup(html).match(TAG_RE) ?? []) {
    const id = attr(tag, 'data-screen');
    if (id === null) continue;
    const w = attr(tag, 'data-width'); const h = attr(tag, 'data-height');
    const kind = attr(tag, 'data-kind'); const code = attr(tag, 'data-code');
    found.push({
      id, name: attr(tag, 'data-screen-name') ?? id, ...(kind !== null ? { kind } : {}), ...(code !== null ? { code } : {}),
      viewport: attr(tag, 'data-viewport') ?? (w && h ? `${w}x${h}` : undefined),
    });
  }
  if (found.length === 0) return refuse('screens', 'no screens found: mark each one with data-screen="<id>" and data-viewport="WxH", or pass screens explicitly');
  return parseScreens(found);
}

/** Comments and script/style elements blanked to spaces, so offsets still line up with the original. */
const blankInert = (html: string): string =>
  html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, m => ' '.repeat(m.length));

/** Where each screen element starts and ends in the file, outermost only. */
function screenRanges(html: string): Array<{ id: string; start: number; end: number }> {
  const text = blankInert(html);
  const out: Array<{ id: string; start: number; end: number }> = [];
  const open = /<([a-z][a-z0-9-]*)\b[^<>]*>/gi;
  for (let m; (m = open.exec(text));) {
    const id = attr(m[0], 'data-screen');
    if (id === null || (out.length && m.index < out[out.length - 1]!.end)) continue;
    // Count the same tag's opens and closes until this one closes.
    const same = new RegExp(String.raw`<(\/?)${m[1]}\b[^<>]*>`, 'gi');
    same.lastIndex = m.index + m[0].length;
    let depth = 1; let end = text.length;
    for (let t; depth > 0 && (t = same.exec(text));) {
      if (t[1]) depth--; else if (!t[0].endsWith('/>')) depth++;
      if (depth === 0) end = t.index + t[0].length;
    }
    out.push({ id, start: m.index, end });
    open.lastIndex = end;
  }
  return out;
}

/**
 * One board of a design export on its own (R-15): the file with every other
 * screen element cut out. The head, the styles and the scripts outside the
 * boards stay, so the board keeps its markup and its logic and still renders.
 * Read as text; nothing is parsed into a DOM or run.
 */
export function screenSource(html: string, screenId: string): { ok: true; html: string } | { ok: false; field: string; message: string } {
  const ranges = screenRanges(html);
  if (!ranges.some(r => r.id === screenId)) {
    return { ok: false, field: 'screenId', message: `this revision has no screen "${screenId}"; it holds ${ranges.map(r => r.id).join(', ') || 'none'}` };
  }
  let out = ''; let at = 0;
  for (const r of ranges) {
    if (r.id === screenId) continue;
    out += html.slice(at, r.start);
    at = r.end;
  }
  return { ok: true, html: out + html.slice(at) };
}
