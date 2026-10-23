/**
 * The design preview on /app/artifacts/[id] (mission "Designs in buildd").
 *
 * A design is one HTML file an agent produced: untrusted. These helpers only
 * read strings (metadata, the raw HTML as text) and shape URLs; nothing here
 * evaluates or parses the document with a DOM. The component that frames it
 * (components/DesignPreview.tsx) loads it from the signed storage URL in a
 * sandboxed iframe, so the design never runs on buildd's origin.
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface DesignScreen {
  /** `section[data-screen=<id>]` in the file; also the URL fragment that shows it. */
  id: string;
  name: string;
  /** The size the screen was drawn at, or null when nothing states one. */
  viewport: Viewport | null;
}

const PHONE_VIEWPORT: Viewport = { width: 390, height: 844 };
const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };

/** A stored HTML file that calls itself a design, or lists its screens. */
export function isDesignArtifact(a: { storageKey: string | null; metadata: Record<string, unknown> | null }): boolean {
  if (!a.storageKey || !a.metadata) return false;
  const mime = typeof a.metadata.mimeType === 'string' ? a.metadata.mimeType.split(';')[0].trim().toLowerCase() : '';
  // A design stored by buildd is written as inert text (designs/upload.ts), so it states text/plain.
  if (a.metadata.kind === 'design') return mime === 'text/html' || mime === 'text/plain';
  return mime === 'text/html' && Array.isArray(a.metadata.screens);
}

/** `WxH` (or `W×H`), or `{ width, height }`; null for anything else. */
export function parseViewport(v: unknown): Viewport | null {
  let width: number | undefined;
  let height: number | undefined;
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(v);
    if (!m) return null;
    width = Number(m[1]);
    height = Number(m[2]);
  } else if (v && typeof v === 'object') {
    const o = v as { width?: unknown; height?: unknown };
    if (typeof o.width !== 'number' || typeof o.height !== 'number') return null;
    width = o.width;
    height = o.height;
  } else {
    return null;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/** `desktop-task-running` → `Desktop task running`. */
function nameFromId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/**
 * `metadata.screens`: a list of ids, or of `{ id, name?, viewport? }`.
 * Entries without an id are dropped.
 */
export function screensFromMetadata(metadata: Record<string, unknown> | null | undefined): DesignScreen[] {
  const raw = metadata?.screens;
  if (!Array.isArray(raw)) return [];
  const out: DesignScreen[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry) out.push({ id: entry, name: nameFromId(entry), viewport: null });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as { id?: unknown; name?: unknown; viewport?: unknown };
    if (typeof o.id !== 'string' || !o.id) continue;
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name ? o.name : nameFromId(o.id),
      viewport: parseViewport(o.viewport),
    });
  }
  return out;
}

const SECTION_RE = /<section\b([^>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * The screens a design file declares itself: each `<section data-screen=…>`
 * with its `data-viewport` (and `data-name`, when given), in document order.
 * Text scanning only: the file is never parsed as a document or executed.
 */
export function screensFromHtml(html: string): DesignScreen[] {
  const out: DesignScreen[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(SECTION_RE)) {
    const attrs = m[1];
    const id = attr(attrs, 'data-screen');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = attr(attrs, 'data-name') ?? attr(attrs, 'data-title');
    out.push({ id, name: name || nameFromId(id), viewport: parseViewport(attr(attrs, 'data-viewport')) });
  }
  return out;
}

/** A last-resort size from the id's prefix, so a screen always has a frame to fit. */
export function inferViewport(id: string): Viewport | null {
  const head = id.toLowerCase();
  if (/^(phone|mobile)\b/.test(head)) return PHONE_VIEWPORT;
  if (/^(desktop|web|wide)\b/.test(head)) return DESKTOP_VIEWPORT;
  return null;
}

/**
 * The picker's screens: metadata's order and names, viewports (and better
 * names) from the HTML sections when the file is at hand, a prefix guess last.
 * With no metadata list, the HTML's sections are the list.
 */
export function resolveDesignScreens(metadata: Record<string, unknown> | null | undefined, html: string | null | undefined): DesignScreen[] {
  const fromMeta = screensFromMetadata(metadata);
  const fromHtml = html ? screensFromHtml(html) : [];
  const byId = new Map(fromHtml.map((s) => [s.id, s]));
  const base = fromMeta.length ? fromMeta : fromHtml;
  return base.map((s) => {
    const h = byId.get(s.id);
    const metaNamed = fromMeta.length > 0 && s.name !== nameFromId(s.id);
    return {
      id: s.id,
      name: metaNamed ? s.name : h?.name ?? s.name,
      viewport: s.viewport ?? h?.viewport ?? inferViewport(s.id),
    };
  });
}

/** `/app/artifacts/<id>?screen=<screen>&revision=<n>`: the link a spec page or a person shares. */
export function designPreviewHref(artifactId: string, opts: { screen?: string | null; revision?: number | string | null }): string {
  const q = new URLSearchParams();
  if (opts.screen) q.set('screen', opts.screen);
  if (opts.revision !== undefined && opts.revision !== null && opts.revision !== '') q.set('revision', String(opts.revision));
  const qs = q.toString();
  return `/app/artifacts/${artifactId}${qs ? `?${qs}` : ''}`;
}

/** The iframe's URL: the signed storage URL, with the screen as its fragment. */
export function frameSrc(signedUrl: string, screenId: string | null): string {
  return screenId ? `${signedUrl}#${encodeURIComponent(screenId)}` : signedUrl;
}

/** Shrink a screen to the column it sits in; never enlarge it. */
export function fitScale(viewportWidth: number, columnWidth: number): number {
  if (!(columnWidth > 0) || !(viewportWidth > 0)) return 1;
  return Math.min(1, columnWidth / viewportWidth);
}
