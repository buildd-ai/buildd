/**
 * Access rules for the runner's local debug/config HTTP server.
 *
 * - The server binds to loopback unless BUILDD_UI_BIND opts into another
 *   interface (e.g. a Tailscale address for remote viewing).
 * - Whether a peer is local is decided from the socket's remote address, never
 *   from Host/Origin headers.
 * - Anything that changes runner state (every non-GET request) and the config
 *   read (which exposes the viewer token) requires the local token, sent as the
 *   X-Buildd-Local-Token header. The token lives in the runner's config dir with
 *   mode 0600; the runner's own UI receives it injected into the served page.
 * - A request carrying an Origin header must come from the server's own origin.
 * - Worker data reads (/api/workers, /api/events, /health) from a non-loopback
 *   peer need the viewer token, as before.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export const LOCAL_TOKEN_HEADER = 'x-buildd-local-token';
export const LOCAL_TOKEN_FILE = 'local-token';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** GET paths that still require the local token. */
const TOKEN_REQUIRED_READS = new Set(['/api/config']);
/** Read paths a non-loopback peer may reach with the viewer token. */
const VIEWER_PATHS = ['/api/workers', '/api/events', '/health'];
/** Static UI assets a non-loopback peer may load with the viewer token (served without the local token). */
const VIEWER_UI_PATHS = new Set(['/', '/index.html', '/icon.png']);

export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a === '::1') return true;
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function resolveBindHost(env: Record<string, string | undefined>): string {
  const v = env.BUILDD_UI_BIND?.trim();
  return v ? v : '127.0.0.1';
}

/**
 * Load the local token from `<dir>/local-token`, creating it if absent. A valid
 * BUILDD_LOCAL_TOKEN in `env` takes precedence (used when a harness on another
 * host drives the runner, e.g. CI) and is persisted to the same file.
 */
export function loadOrCreateLocalToken(
  dir: string,
  env: Record<string, string | undefined> = {},
): { token: string; path: string } {
  const path = join(dir, LOCAL_TOKEN_FILE);
  const fromEnv = env.BUILDD_LOCAL_TOKEN?.trim();
  if (fromEnv && TOKEN_RE.test(fromEnv)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, fromEnv + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    return { token: fromEnv, path };
  }
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, 'utf8').trim();
      if (TOKEN_RE.test(existing)) {
        if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
        return { token: existing, path };
      }
    } catch {
      // fall through and regenerate
    }
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path };
}

/**
 * Read the local token as a client (tests, scripts): BUILDD_LOCAL_TOKEN, else
 * the token file under BUILDD_HOME (default ~/.buildd). Returns null if absent.
 */
export function readLocalToken(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.BUILDD_LOCAL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const home = env.BUILDD_HOME || join(env.HOME || '', '.buildd');
  try {
    const t = readFileSync(join(home, LOCAL_TOKEN_FILE), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inject the local token into the runner UI page, plus a fetch wrapper that
 * attaches it to same-origin requests so the page's own calls keep working.
 */
export function injectLocalToken(html: string, token: string): string {
  const snippet =
    `<meta name="buildd-local-token" content="${escapeHtml(token)}">` +
    `<script>(function(){var t=document.querySelector('meta[name="buildd-local-token"]').content;` +
    `var f=window.fetch.bind(window);window.fetch=function(input,init){` +
    `try{var u=new URL(typeof input==='string'?input:(input&&input.url)||'',location.href);` +
    `if(u.origin===location.origin){init=init||{};var h=new Headers(init.headers||(typeof input!=='string'&&input.headers)||{});` +
    `h.set('${LOCAL_TOKEN_HEADER}',t);init.headers=h;}}catch(e){}return f(input,init);};})();</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (!m || m.index === undefined) return snippet + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface LocalRequestInfo {
  method: string;
  path: string;
  headers: Headers;
  query?: URLSearchParams;
  /** Socket remote address (Bun `server.requestIP(req)?.address`). */
  remoteAddr: string | null | undefined;
  token: string;
  viewerToken?: string | null;
  /** Origins the server itself is reachable under (e.g. http://127.0.0.1:8766). */
  ownOrigins: string[];
}

export type LocalAuthDenial = { status: number; error: string };

export function authorizeLocalRequest(info: LocalRequestInfo): LocalAuthDenial | null {
  const method = info.method.toUpperCase();
  const { path, headers } = info;
  const loopback = isLoopbackAddress(info.remoteAddr);

  const origin = headers.get('origin');
  if (origin && origin !== 'null' && !info.ownOrigins.includes(origin)) {
    return { status: 403, error: 'Cross-origin requests are not accepted' };
  }
  if (origin === 'null' && !SAFE_METHODS.has(method)) {
    return { status: 403, error: 'Cross-origin requests are not accepted' };
  }

  const hasLocalToken = safeEqual(headers.get(LOCAL_TOKEN_HEADER), info.token);
  if (hasLocalToken) return null;

  if (method === 'OPTIONS') return null;

  const needsLocalToken = !SAFE_METHODS.has(method) || TOKEN_REQUIRED_READS.has(path);
  if (needsLocalToken) {
    return { status: 403, error: 'Missing or invalid local token' };
  }

  if (loopback) return null;

  // Non-loopback peer (only reachable when BUILDD_UI_BIND opts in): read-only
  // worker data and the UI shell with the viewer token; nothing else.
  const isViewerPath =
    VIEWER_UI_PATHS.has(path) || VIEWER_PATHS.some((p) => path === p || path.startsWith(p + '/'));
  if (isViewerPath) {
    const provided =
      info.query?.get('token') || headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
    if (safeEqual(provided, info.viewerToken ?? null)) return null;
    return { status: 401, error: 'Unauthorized - invalid viewer token' };
  }
  return { status: 403, error: 'Only available to local requests' };
}
