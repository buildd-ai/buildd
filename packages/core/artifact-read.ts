/**
 * Bounded reads of an artifact body, so an agent can work from a long
 * reference (a spec, a 200-page manual) without loading all of it into its
 * context: an outline of its Markdown headings, one section, a character
 * range, or the lines matching a search. Pure: the route reads the body and
 * records which of these views was returned (artifact_reads).
 *
 * Offsets are UTF-16 code-unit indexes into the stored string (what
 * JavaScript `slice` uses), so a range a caller got back from `outline` or
 * `grep` reads exactly that text.
 */

export const ARTIFACT_READ_VIEWS = ['auto', 'full', 'meta', 'outline', 'section', 'range', 'grep'] as const;
export type ArtifactReadView = (typeof ARTIFACT_READ_VIEWS)[number];

/** `auto` returns the whole body up to this many characters, else the outline. */
export const AUTO_FULL_MAX_CHARS = 20_000;
/** Most characters one `range` or `section` read returns. */
export const MAX_SLICE_CHARS = 20_000;
export const MAX_GREP_MATCHES = 50;
export const MAX_OUTLINE_SECTIONS = 500;

export interface OutlineSection {
  /** Stable within one revision: `s<index>`, in document order. */
  id: string;
  level: number;
  title: string;
  /** Offset of the heading line. */
  start: number;
  /** Offset just past the section's last character (the next heading at the same or a higher level). */
  end: number;
  chars: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^(```|~~~)/;

export function outlineOf(body: string): OutlineSection[] {
  const heads: Array<{ level: number; title: string; start: number }> = [];
  let offset = 0;
  let fenced = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line.trimStart())) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m) heads.push({ level: m[1].length, title: m[2].trim(), start: offset });
    }
    offset += line.length + 1;
  }
  const out: OutlineSection[] = heads.slice(0, MAX_OUTLINE_SECTIONS).map((h, i) => {
    const next = heads.slice(i + 1).find((n) => n.level <= h.level);
    const end = next ? next.start : body.length;
    return { id: `s${i + 1}`, level: h.level, title: h.title, start: h.start, end, chars: end - h.start };
  });
  return out;
}

export type ArtifactReadSelector =
  | { view: 'full' }
  | { view: 'meta' }
  | { view: 'outline' }
  | { view: 'section'; section: string }
  | { view: 'range'; offset: number; length: number }
  | { view: 'grep'; pattern: string; context?: number };

export type ArtifactReadResult =
  | { view: 'full'; text: string; chars: number }
  | { view: 'meta'; chars: number; sections: number }
  | { view: 'outline'; chars: number; sections: OutlineSection[] }
  | { view: 'section'; chars: number; section: OutlineSection; text: string; truncated: boolean }
  | { view: 'range'; chars: number; offset: number; length: number; text: string; truncated: boolean }
  | { view: 'grep'; chars: number; pattern: string; matches: Array<{ line: number; offset: number; text: string }>; truncated: boolean };

export class ArtifactReadError extends Error {}

/** Parse a selector from query params; `auto` resolves against the body. */
export function parseReadSelector(params: URLSearchParams, body: string): ArtifactReadSelector | null {
  const view = params.get('view');
  if (view === null) return null;
  if (!(ARTIFACT_READ_VIEWS as readonly string[]).includes(view)) {
    throw new ArtifactReadError(`view must be one of: ${ARTIFACT_READ_VIEWS.join(', ')}`);
  }
  switch (view as ArtifactReadView) {
    case 'auto':
      return body.length <= AUTO_FULL_MAX_CHARS ? { view: 'full' } : { view: 'outline' };
    case 'full':
    case 'meta':
    case 'outline':
      return { view: view as 'full' | 'meta' | 'outline' };
    case 'section': {
      const section = params.get('section');
      if (!section) throw new ArtifactReadError('view=section needs section=<id from the outline>');
      return { view: 'section', section };
    }
    case 'range': {
      const offset = Number(params.get('offset') ?? 0);
      const length = Number(params.get('length') ?? MAX_SLICE_CHARS);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1) {
        throw new ArtifactReadError('view=range needs a non-negative integer offset and a positive integer length');
      }
      return { view: 'range', offset, length };
    }
    case 'grep': {
      const pattern = params.get('grep') ?? '';
      if (!pattern.trim()) throw new ArtifactReadError('view=grep needs grep=<text to find>');
      if (pattern.length > 200) throw new ArtifactReadError('grep is at most 200 characters');
      const context = Number(params.get('context') ?? 0);
      return { view: 'grep', pattern, context: Number.isInteger(context) && context > 0 ? Math.min(context, 5) : 0 };
    }
  }
}

export function readArtifactBody(body: string, sel: ArtifactReadSelector): ArtifactReadResult {
  const chars = body.length;
  switch (sel.view) {
    case 'full':
      return { view: 'full', text: body, chars };
    case 'meta':
      return { view: 'meta', chars, sections: outlineOf(body).length };
    case 'outline':
      return { view: 'outline', chars, sections: outlineOf(body) };
    case 'section': {
      const section = outlineOf(body).find((s) => s.id === sel.section);
      if (!section) throw new ArtifactReadError(`no section ${sel.section}; read view=outline for the ids`);
      const truncated = section.chars > MAX_SLICE_CHARS;
      return { view: 'section', chars, section, text: body.slice(section.start, section.start + Math.min(section.chars, MAX_SLICE_CHARS)), truncated };
    }
    case 'range': {
      const length = Math.min(sel.length, MAX_SLICE_CHARS);
      const text = body.slice(sel.offset, sel.offset + length);
      return { view: 'range', chars, offset: sel.offset, length: text.length, text, truncated: sel.length > MAX_SLICE_CHARS };
    }
    case 'grep': {
      // Literal, case-insensitive: no caller-supplied regex reaches the engine.
      const needle = sel.pattern.toLowerCase();
      const lines = body.split('\n');
      const matches: Array<{ line: number; offset: number; text: string }> = [];
      let offset = 0;
      let truncated = false;
      const starts: number[] = [];
      for (const l of lines) { starts.push(offset); offset += l.length + 1; }
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        if (matches.length >= MAX_GREP_MATCHES) { truncated = true; break; }
        const from = Math.max(0, i - (sel.context ?? 0));
        const to = Math.min(lines.length - 1, i + (sel.context ?? 0));
        matches.push({ line: i + 1, offset: starts[from], text: lines.slice(from, to + 1).join('\n').slice(0, 2_000) });
      }
      return { view: 'grep', chars, pattern: sel.pattern, matches, truncated };
    }
  }
}

/** Characters of the body a result hands back, for the read ledger. */
export function returnedChars(r: ArtifactReadResult): number {
  switch (r.view) {
    case 'full':
    case 'section':
    case 'range':
      return r.text.length;
    case 'grep':
      return r.matches.reduce((n, m) => n + m.text.length, 0);
    default:
      return 0;
  }
}
