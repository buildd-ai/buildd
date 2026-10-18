import { NextRequest, NextResponse } from "next/server";
import {
  classifyApiRead,
  gateApiRead,
  rateLimitedResponse,
  readSubjectForKey,
  readSubjectForUser,
  type ReadVerdict,
} from "./lib/read-rate-limit";

const INSTALL_REDIRECTS: Record<string, string> = {
  "/install.sh":
    "https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/runner/install.sh",
  "/install.ps1":
    "https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/runner/install.ps1",
};

/**
 * The apex host serves the app; the marketing site lives on www. Only the
 * apex is split — previews, localhost and every other host keep app
 * behaviour, and runners/MCP/webhooks/OAuth (all under /api or /app) are
 * never matched at all.
 */
const APEX_HOST = "buildd.dev";
const MARKETING_ORIGIN = "https://www.buildd.dev";

/** Top-level pages the marketing site owns. Exact paths only. */
export const MARKETING_PATHS: ReadonlySet<string> = new Set([
  "/pricing",
  "/integrations",
  "/memory",
  "/ai-kit",
  "/privacy",
  "/terms",
]);

/**
 * Where /memory went before the marketing site took it over. Kept for
 * non-apex hosts so previews behave as they did.
 */
const LEGACY_MEMORY_DEST = "https://docs.buildd.dev/docs/features/memory";

/**
 * Auth.js session cookie names: `authjs.session-token` (http, or when
 * AUTH_COOKIE_DOMAIN pins the name in auth.ts) and `__Secure-authjs.session-token`
 * (default on https). Large sessions are chunked as `<name>.0`, `<name>.1`, ...
 *
 * Presence only — the proxy does no DB or JWT work. A stale cookie just means
 * the visitor lands on /app/home and the app's own auth sends them to sign-in,
 * which is today's behaviour.
 */
const SESSION_COOKIE_RE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => SESSION_COOKIE_RE.test(c.name) && c.value.length > 0);
}

function isApex(request: NextRequest): boolean {
  const host = (request.headers.get("host") ?? request.nextUrl.host)
    .toLowerCase()
    .replace(/:\d+$/, "");
  return host === APEX_HOST;
}

function toMarketing(request: NextRequest, status: 307 | 308) {
  const dest = new URL(request.nextUrl.pathname, MARKETING_ORIGIN);
  dest.search = request.nextUrl.search;
  return NextResponse.redirect(dest, status);
}

/**
 * The signed-in user of a browser session, from the Auth.js JWT cookie: no
 * database. The cookie's name follows auth.ts (the `__Secure-` prefix only
 * when AUTH_COOKIE_DOMAIN does not pin the plain name).
 */
async function sessionUserIdFromCookie(request: NextRequest): Promise<string | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  try {
    const { getToken } = await import("next-auth/jwt");
    const secureCookie = request.cookies.getAll().some((c) => c.name.startsWith("__Secure-authjs.session-token"));
    const token = await getToken({ req: request, secret, secureCookie });
    const id = token?.userId ?? token?.sub;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export interface ApiReadDeps {
  gate?: (req: { method: string; pathname: string }, subject: string | null) => Promise<ReadVerdict>;
  sessionUserId?: (request: NextRequest) => Promise<string | null>;
}

/**
 * The read rate limit (lib/read-rate-limit.ts): GET/HEAD under /api, per API
 * key or per signed-in user. Writes and exempt routes pass untouched, without
 * a Redis call; a refusal is a 429 with Retry-After.
 */
export async function apiReadProxy(request: NextRequest, deps: ApiReadDeps = {}): Promise<Response> {
  const req = { method: request.method, pathname: request.nextUrl.pathname };
  if (!classifyApiRead(req.method, req.pathname)) return NextResponse.next();
  // Same extraction as the routes, so the subject matches what the server records the plan under.
  const bearer = request.headers.get("authorization")?.replace("Bearer ", "") || null;
  let subject: string | null = null;
  if (bearer) subject = readSubjectForKey(bearer);
  else if (hasSessionCookie(request)) {
    const userId = await (deps.sessionUserId ?? sessionUserIdFromCookie)(request);
    subject = userId ? readSubjectForUser(userId) : null;
  }
  const verdict = await (deps.gate ?? ((r, s) => gateApiRead(r, s)))(req, subject);
  return verdict.allowed ? NextResponse.next() : rateLimitedResponse(verdict);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) return apiReadProxy(request);

  const install = INSTALL_REDIRECTS[pathname];
  if (install) {
    return NextResponse.redirect(install, 302);
  }

  const apex = isApex(request);

  if (pathname === "/") {
    // 307, never permanent: the destination depends on the cookie, and a
    // cached permanent redirect would lock signed-in users out of the app root.
    if (apex && !hasSessionCookie(request)) {
      return toMarketing(request, 307);
    }
    return NextResponse.redirect(new URL("/app/home", request.url), 307);
  }

  if (MARKETING_PATHS.has(pathname)) {
    if (apex) return toMarketing(request, 308);
    if (pathname === "/memory") {
      return NextResponse.redirect(LEGACY_MEMORY_DEST, 307);
    }
  }

  return NextResponse.next();
}

// Must stay a literal: Next statically analyses the matcher. Keep in sync
// with MARKETING_PATHS (proxy.test.ts enforces it). /api is matched only for
// the read rate limit; nothing under it is ever redirected.
export const config = {
  matcher: [
    "/api/:path*",
    "/",
    "/install.sh",
    "/install.ps1",
    "/pricing",
    "/integrations",
    "/memory",
    "/ai-kit",
    "/privacy",
    "/terms",
  ],
};
