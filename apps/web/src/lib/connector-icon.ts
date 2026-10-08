import { catalogEntryForUrl } from './connector-catalog';
import { defaultResolveHost, validatePublicEndpoint, type ResolveHost } from './public-endpoint';

/**
 * Best-effort icon for a connector URL. Candidate order:
 *   1. catalog entry for the URL (no network);
 *   2. `serverInfo.icons` from an MCP `initialize` (spec 2025-11-25) — anonymous
 *      at create time, authenticated once the OAuth callback has a token;
 *   3. `<link rel=icon>` then `/favicon.ico` on `serverInfo.websiteUrl`;
 *   4. `<link rel=icon>` on the server's origin, then on its apex domain
 *      (mcp.example.com → example.com), since most MCP hosts serve no HTML;
 *   5. `/favicon.ico` on the same two origins.
 *
 * `resolveConnectorIcon` returns the first candidate URL (catalog entries store
 * that). `resolveConnectorIconData` downloads candidates in order and returns
 * the first that is a small image, as a `data:` URL — connector rows store
 * that, so the dashboard never requests a third-party host. Every fetch is
 * https-only and re-checks each redirect hop against the SSRF guard.
 * Never throws: a connector without an icon renders a letter avatar.
 */

const TIMEOUT_MS = 3000;
const MAX_HTML_BYTES = 256 * 1024;
/** Raw bytes; stored base64 in `connectors.iconUrl`, so ~87KB per row at most. */
export const MAX_ICON_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

const IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif',
]);

interface Opts {
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
  /** Sent on `initialize` only — e.g. the connector's OAuth bearer. */
  headers?: Record<string, string>;
}

function iconUrl(raw: string, base?: string): string | null {
  if (/^data:/i.test(raw)) return dataImageType(raw) ? raw : null;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function dataImageType(raw: string): string | null {
  const m = raw.match(/^data:([^;,]+)[^,]*;base64,/i);
  const type = m?.[1].toLowerCase();
  return type && IMAGE_TYPES.has(type) ? type : null;
}

function rankIcon(icon: { mimeType?: unknown; sizes?: unknown; theme?: unknown }, src: string): number {
  const theme = icon.theme === 'dark' ? 0 : 1;
  const type = typeof icon.mimeType === 'string' ? icon.mimeType.toLowerCase() : (dataImageType(src) ?? '');
  const ext = src.split(/[?#]/)[0].toLowerCase();
  const isIco = type.includes('icon') || ext.endsWith('.ico');
  const vector = type === 'image/svg+xml' || ext.endsWith('.svg');
  const sizes = Array.isArray(icon.sizes) ? icon.sizes.filter((s): s is string => typeof s === 'string') : [];
  const px = sizes.includes('any') ? 512 : Math.max(0, ...sizes.map(s => Number(s.split('x')[0]) || 0));
  return theme * 10000 + (isIco ? 0 : 1000) + Math.min(vector ? 512 : px, 512);
}

/** Best icon from `serverInfo.icons`: light/unthemed over dark, png/svg over ico, larger over smaller. */
export function iconFromServerInfo(serverInfo: unknown, serverUrl: string): string | null {
  const icons = (serverInfo as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(icons)) return null;
  let best: { rank: number; url: string } | null = null;
  for (const icon of icons) {
    const src = (icon as { src?: unknown } | null)?.src;
    if (typeof src !== 'string') continue;
    const url = iconUrl(src, serverUrl);
    if (!url) continue;
    const rank = rankIcon(icon as object, url);
    if (!best || rank > best.rank) best = { rank, url };
  }
  return best?.url ?? null;
}

const LINK_RE = /<link\b[^>]*>/gi;
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(v => v !== undefined) ?? null;

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function iconFromHtml(html: string, pageUrl: string): string | null {
  let best: { rank: number; href: string } | null = null;
  for (const tag of html.match(LINK_RE) ?? []) {
    const rel = attr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = attr(tag, 'href');
    if (!href) continue;
    const rank = rel.includes('apple-touch-icon') ? 2 : rel.includes('icon') ? 1 : 0;
    if (rank > (best?.rank ?? 0)) best = { rank, href };
  }
  return best ? iconUrl(decodeEntities(best.href), pageUrl) : null;
}

/**
 * Fetch through the SSRF guard. Redirects are followed by hand (GET only) so
 * each hop is re-validated; `url` on the result is the final hop.
 */
async function guardedFetch(o: Opts, url: string, init: RequestInit = {}): Promise<{ res: Response; url: string } | null> {
  const f = o.fetch ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await validatePublicEndpoint(current, o.resolveHost ?? defaultResolveHost)).ok) return null;
    let res: Response;
    try {
      res = await f(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return null;
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return { res, url: current };
    if (init.method && init.method !== 'GET') return null;
    try { current = new URL(location, current).toString(); } catch { return null; }
  }
  return null;
}

/** Body up to `max` bytes, or null when it is larger. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function readText(res: Response): Promise<string> {
  const bytes = await readCapped(res, MAX_HTML_BYTES);
  return bytes ? new TextDecoder().decode(bytes) : '';
}

function sniffImageType(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/**
 * An icon as a `data:` URL: an image `data:` URI passes through (size-capped);
 * an https URL is downloaded through the SSRF guard and must be a small image.
 * SVG is kept — it is only ever rendered via <img>, where scripts do not run.
 */
export async function inlineIcon(src: string, opts: Opts = {}): Promise<string | null> {
  if (/^data:/i.test(src)) {
    if (!dataImageType(src)) return null;
    return src.length <= Math.ceil(MAX_ICON_BYTES * 4 / 3) + 64 ? src : null;
  }
  const got = await guardedFetch(opts, src, { headers: { accept: 'image/*' } });
  if (!got?.res.ok) return null;
  const bytes = await readCapped(got.res, MAX_ICON_BYTES);
  if (!bytes || bytes.byteLength === 0) return null;
  const declared = (got.res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const type = IMAGE_TYPES.has(declared) ? declared : sniffImageType(bytes);
  if (!type) return null;
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function initializeInfo(o: Opts, serverUrl: string): Promise<{ icon: string | null; websiteUrl: string | null }> {
  const none = { icon: null, websiteUrl: null };
  const got = await guardedFetch(o, serverUrl, {
    method: 'POST',
    headers: { ...o.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'buildd-icon-probe', version: '1' } },
    }),
  });
  if (!got?.res.ok) return none;
  const text = await readText(got.res);
  // Streamable HTTP may answer as SSE: take the first `data:` line that parses.
  const payloads = text.trimStart().startsWith('{')
    ? [text]
    : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5));
  for (const p of payloads) {
    try {
      const info = JSON.parse(p)?.result?.serverInfo;
      if (!info) continue;
      const site = typeof info.websiteUrl === 'string' ? iconUrl(info.websiteUrl) : null;
      return { icon: iconFromServerInfo(info, serverUrl), websiteUrl: site && !site.startsWith('data:') ? site : null };
    } catch { /* not JSON — try next */ }
  }
  return none;
}

/** mcp.example.com → [https://mcp.example.com/, https://example.com/] */
function candidateOrigins(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const origins = [`${u.protocol}//${u.host}/`];
  const labels = u.hostname.split('.');
  if (labels.length > 2 && !/^\d+$/.test(labels[labels.length - 1])) {
    origins.push(`${u.protocol}//${labels.slice(-2).join('.')}/`);
  }
  return origins;
}

async function iconFromSite(o: Opts, page: string): Promise<string | null> {
  const got = await guardedFetch(o, page, { headers: { accept: 'text/html' } });
  if (got?.res.ok && (got.res.headers.get('content-type') ?? '').includes('text/html')) {
    return iconFromHtml(await readText(got.res), got.url);
  }
  return null;
}

async function faviconIco(o: Opts, origin: string): Promise<string | null> {
  const url = new URL('/favicon.ico', origin).toString();
  const got = await guardedFetch(o, url);
  const ok = got?.res.ok && (got.res.headers.get('content-type') ?? '').startsWith('image/');
  await got?.res.body?.cancel().catch(() => {});
  return ok ? url : null;
}

/** Icon candidates in fallback order; lazily, so callers stop at the first that works. */
async function* iconCandidates(serverUrl: string, o: Opts): AsyncGenerator<string> {
  const catalog = catalogEntryForUrl(serverUrl);
  if (catalog?.iconUrl) yield catalog.iconUrl;
  if (!iconUrl(serverUrl) || serverUrl.startsWith('data:')) return;
  const { icon, websiteUrl } = await initializeInfo(o, serverUrl);
  if (icon) yield icon;
  const sites = websiteUrl ? [websiteUrl] : [];
  const origins = candidateOrigins(serverUrl).filter(x => !sites.includes(x));
  for (const page of [...sites, ...origins]) {
    const found = await iconFromSite(o, page);
    if (found) yield found;
  }
  for (const page of [...sites, ...origins]) {
    const found = await faviconIco(o, page);
    if (found) yield found;
  }
}

export async function resolveConnectorIcon(serverUrl: string, opts: Opts = {}): Promise<string | null> {
  try {
    for await (const c of iconCandidates(serverUrl, opts)) return c;
  } catch { /* best effort */ }
  return null;
}

/** First candidate (after `preferred`, e.g. a catalog entry's icon) that downloads as a small image. */
export async function resolveConnectorIconData(
  serverUrl: string,
  opts: Opts & { preferred?: string | null } = {},
): Promise<string | null> {
  try {
    if (opts.preferred) {
      const inlined = await inlineIcon(opts.preferred, opts);
      if (inlined) return inlined;
    }
    for await (const c of iconCandidates(serverUrl, opts)) {
      if (c === opts.preferred) continue;
      const inlined = await inlineIcon(c, opts);
      if (inlined) return inlined;
    }
  } catch { /* best effort */ }
  return null;
}
