/**
 * Egress credential injection: pure decisions for the container's outbound
 * requests. No Workers runtime imports, so Bun tests load this file directly.
 * `EgressHandler` (egress.ts) is the WorkerEntrypoint that applies them, and
 * `WorkerAgent.installEgressHandlers` routes the container's traffic to it.
 *
 * Invariant: a request from the container never leaves with a credential the
 * container supplied. For every host this module rewrites, `x-api-key`,
 * `authorization` and friends are deleted first and only then is the real
 * credential (held by the Worker, never by the container) added.
 *
 *   api.anthropic.com        -> per resolveModelRoute: an Anthropic-compatible proxy such as
 *                               LiteLLM (`Authorization: Bearer <proxy key>` or `x-api-key`),
 *                               or AI Gateway (`cf-aig-authorization: Bearer <gateway token>`);
 *                               only MODEL_API_ROUTES, anything else is refused (403)
 *   github.com (git https)   -> `Authorization: Basic x-access-token:<installation token>`
 *   api.github.com, uploads  -> `Authorization: Bearer <installation token>`
 *   codeload.github.com      -> container auth stripped, nothing added
 *   buildd-snapshots.invalid -> never forwarded: served by the snapshot store (snapshots.ts),
 *                               and intercepted only with warm repos on
 *   anything else            -> untouched (open egress in phase 1)
 *
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 4.
 */

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/** Hosts whose traffic is routed through the egress handler. */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'uploads.github.com', 'codeload.github.com'] as const;
export const INTERCEPTED_HOSTS: readonly string[] = [ANTHROPIC_HOST, ...GITHUB_HOSTS];
/**
 * Mirrors SNAPSHOT_HOST in snapshots.ts (not imported, to keep this file's
 * imports empty). outbound.test.ts checks they are equal. Not in
 * INTERCEPTED_HOSTS: the agent intercepts it only when warm repos are on.
 */
export const SNAPSHOT_HOST_NAME = 'buildd-snapshots.invalid';

/**
 * Request headers that can carry a credential. All are removed from a
 * rewritten request before the Worker adds its own. `cookie` is included
 * because github.com accepts a session cookie.
 */
export const CONTAINER_CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'anthropic-api-key',
  'cf-aig-authorization',
  'cookie',
] as const;

// ── Config ────────────────────────────────────────────────────────────────────

/** Worker vars/secrets the handler reads. See README "Egress credentials". */
export interface EgressEnv {
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Secret. Sent as `cf-aig-authorization`; the Anthropic key itself lives in AI Gateway. */
  AI_GATEWAY_TOKEN?: string;
  /** Secret, local development only. Used only when ALLOW_DIRECT_ANTHROPIC=1. */
  ANTHROPIC_DIRECT_API_KEY?: string;
  /** Var, local development only. `1` sends model traffic straight to Anthropic. Default off. */
  ALLOW_DIRECT_ANTHROPIC?: string;
  /**
   * Base URL of an Anthropic-compatible proxy (LiteLLM and similar). The
   * container's path and query are appended, so `https://litellm.example.com`
   * receives `/v1/messages`; only MODEL_API_ROUTES are forwarded. Setting it selects the proxy route over AI Gateway.
   */
  MODEL_PROXY_URL?: string;
  /** Secret. The proxy's key (for LiteLLM, a virtual key or the master key). */
  MODEL_PROXY_KEY?: string;
  /** `authorization` (default, `Authorization: Bearer <key>`) or `x-api-key` (the raw key). */
  MODEL_PROXY_AUTH_HEADER?: string;
}

export type ModelProxyAuthHeader = 'authorization' | 'x-api-key';

export type ModelRoute =
  | { kind: 'gateway'; baseUrl: string; token: string }
  | { kind: 'proxy'; baseUrl: string; key: string; authHeader: ModelProxyAuthHeader; mapModel?: (id: string) => string }
  | { kind: 'direct'; apiKey: string }
  | { kind: 'unconfigured'; reason: string };

const GATEWAY_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Plain http is accepted only for a proxy on the same machine or the docker
 * host (local testing). Same rule, duplicated on purpose so the Worker pulls
 * in no web code, as the webhookConfig PATCH in
 * apps/web/src/app/api/workspaces/[id]/route.ts (LOCAL_HTTP_HOSTS).
 */
export const LOCAL_HTTP_HOSTS: readonly string[] = ['localhost', '127.0.0.1', 'host.docker.internal'];

/**
 * Validate MODEL_PROXY_URL and normalise it to a base the request path is
 * appended to: https only (http only for LOCAL_HTTP_HOSTS), no userinfo, no
 * query or fragment, trailing slashes dropped.
 */
export function parseModelProxyUrl(raw: string): { ok: true; baseUrl: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'MODEL_PROXY_URL is not a valid URL' };
  }
  if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.includes(url.hostname)) {
      return { ok: false, error: `MODEL_PROXY_URL must be https (plain http only for ${LOCAL_HTTP_HOSTS.join(', ')})` };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, error: 'MODEL_PROXY_URL must be https' };
  }
  if (url.username || url.password || raw.includes('@')) {
    return { ok: false, error: 'MODEL_PROXY_URL must not carry credentials; set MODEL_PROXY_KEY instead' };
  }
  // `new URL` drops a bare `?` or `#`, so check the raw string too.
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { ok: false, error: 'MODEL_PROXY_URL must not have a query or fragment' };
  }
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** `authorization` (the default) or `x-api-key`; null for anything else. */
export function parseModelProxyAuthHeader(raw: string | undefined): ModelProxyAuthHeader | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'authorization') return 'authorization';
  if (v === 'x-api-key') return 'x-api-key';
  return null;
}

/**
 * The team's agent model endpoint as `POST /api/runner/model-endpoint`
 * returns it (docs/design/agent-model-endpoint.md §3). Held only in the
 * WorkerAgent's memory for one run.
 */
export interface ServerModelEndpoint {
  baseUrl: string;
  key: string;
  authHeader: ModelProxyAuthHeader;
  /** The endpoint kind (`url`, `gateway`, `openrouter`); decides how model ids are named. */
  kind?: string;
  /** The team's model aliases (native id → endpoint id). */
  models?: Record<string, string>;
  /**
   * Set only when the task's own `anthropic_api_key` resolved ahead of any
   * `agent_endpoint` (docs/credentials-architecture.md scoping) — never an
   * OAuth seat or Claude credential; those stay out of cloud egress. Changes
   * precedence in `resolveModelRoute`: this beats the Worker's
   * `MODEL_PROXY_URL` override, where an ordinary (`agent_endpoint`) server
   * route does not. `baseUrl`/`authHeader` are still `api.anthropic.com` /
   * `x-api-key`, so every other code path treats it as a plain `proxy` route.
   */
  source?: 'anthropic_api_key';
}

/**
 * What the egress handler knows about the server endpoint for this run:
 * an endpoint, `null` (the server said there is none: fall through), or
 * `'unavailable'` (the lookup failed or the endpoint just rejected its key:
 * refuse rather than silently spend on a different route).
 */
export type ServerModelEndpointState = ServerModelEndpoint | null | 'unavailable';

function directAllowed(env: EgressEnv): boolean {
  return env.ALLOW_DIRECT_ANTHROPIC === '1' && !!env.ANTHROPIC_DIRECT_API_KEY;
}

/**
 * Whether the server must be asked before the route can be decided. True
 * whenever the local direct escape hatch does not apply — including when
 * `MODEL_PROXY_URL` is set, unlike before `source: 'anthropic_api_key'`
 * existed: the handler now has to find out whether the task's own Anthropic
 * key would win before letting the operator's override claim the request
 * (see resolveModelRoute). A team with no such key costs one extra lookup
 * (cached for the run, same as any other outcome) and otherwise routes
 * exactly as before.
 */
export function needsServerModelEndpoint(env: EgressEnv): boolean {
  return !directAllowed(env);
}

/**
 * Where model traffic goes. Precedence: direct (local only) > the task's own
 * `anthropic_api_key` (`server.source === 'anthropic_api_key'`) > proxy (when
 * MODEL_PROXY_URL is set, the operator override) > the server-provided
 * `agent_endpoint` > gateway. The direct escape hatch needs both the opt-in
 * var and the key, so a stray `ANTHROPIC_DIRECT_API_KEY` alone changes
 * nothing.
 *
 * The task's own Anthropic key jumps ahead of MODEL_PROXY_URL on purpose: that
 * key is the team's own metered credential, resolved with exactly the scoping
 * a self-hosted runner would use (docs/credentials-architecture.md); unlike an
 * `agent_endpoint`, storing it is not an opt-in to route agents through
 * anything, so a Worker-level proxy pin must not silently spend it on the
 * operator's route instead. `MODEL_PROXY_URL` stays the one deliberate
 * override: once set, it commits (invalid or keyless is refused, never a
 * silent fall to the gateway) and still beats a team's `agent_endpoint` and
 * `'unavailable'`, exactly as before this key existed.
 *
 * The server endpoint produces the same `proxy` shape either way, so
 * rewriteOutbound is unchanged. With no route configured the request is
 * refused rather than forwarded with the container's placeholder key. With
 * `server` omitted or null the result is exactly the pre-endpoint one.
 */
export function resolveModelRoute(env: EgressEnv, server?: ServerModelEndpointState): ModelRoute {
  if (directAllowed(env)) {
    return { kind: 'direct', apiKey: env.ANTHROPIC_DIRECT_API_KEY! };
  }
  if (server && server !== 'unavailable' && server.source === 'anthropic_api_key') {
    return { kind: 'proxy', baseUrl: server.baseUrl, key: server.key, authHeader: server.authHeader };
  }
  if (env.MODEL_PROXY_URL) {
    const parsed = parseModelProxyUrl(env.MODEL_PROXY_URL);
    if (!parsed.ok) return { kind: 'unconfigured', reason: parsed.error };
    if (!env.MODEL_PROXY_KEY) {
      return { kind: 'unconfigured', reason: 'MODEL_PROXY_URL is set but MODEL_PROXY_KEY is not' };
    }
    const authHeader = parseModelProxyAuthHeader(env.MODEL_PROXY_AUTH_HEADER);
    if (!authHeader) {
      return { kind: 'unconfigured', reason: 'MODEL_PROXY_AUTH_HEADER must be authorization or x-api-key' };
    }
    return { kind: 'proxy', baseUrl: parsed.baseUrl, key: env.MODEL_PROXY_KEY, authHeader };
  }
  if (server === 'unavailable') {
    return { kind: 'unconfigured', reason: 'the team agent model endpoint is temporarily unavailable' };
  }
  if (server) {
    const route: ModelRoute = { kind: 'proxy', baseUrl: server.baseUrl, key: server.key, authHeader: server.authHeader };
    if (server.kind === 'openrouter' || (server.models && Object.keys(server.models).length > 0)) {
      route.mapModel = (id: string) => mapEndpointModel({ kind: server.kind, models: server.models }, id);
    }
    return route;
  }
  const account = env.AI_GATEWAY_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_ID;
  const token = env.AI_GATEWAY_TOKEN;
  if (!account || !gateway || !token) {
    return { kind: 'unconfigured', reason: 'AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN must all be set' };
  }
  if (!GATEWAY_SEGMENT_RE.test(account) || !GATEWAY_SEGMENT_RE.test(gateway)) {
    return { kind: 'unconfigured', reason: 'AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID contain unexpected characters' };
  }
  return { kind: 'gateway', baseUrl: `https://${AI_GATEWAY_HOST}/v1/${account}/${gateway}/anthropic`, token };
}

// ── GitHub grant ──────────────────────────────────────────────────────────────

/** A repo-scoped installation token, as returned by `POST /api/runner/github-token`. */
export interface GithubGrant {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  owner: string;
  repo: string;
  /** The task's workspace, as buildd knows it. Keys the snapshot store (snapshots.ts). */
  workspaceId?: string;
  /** The workspace's warm snapshot cap, resolved and bounded by buildd; absent when it sets none. */
  warmSnapshotMaxBytes?: number;
  /**
   * Branch names a direct `git push` must never target (the workspace trunk,
   * its release branch, and the repo's own GitHub default branch) — computed
   * server-side (apps/web/src/app/api/runner/github-token/route.ts) from the
   * same `protectedBaseBranches()` the merge-policy bound uses, plus the
   * repo's `defaultBranch`. Absent on an older buildd server: push protection
   * is then a no-op (`pushedProtectedBranch` fails open), but the REST/GraphQL
   * merge blocks below apply regardless.
   */
  protectedBranches?: string[];
  /**
   * The only branches this task may move: its worker's own branch (and the
   * task's shared working branch, when it has one), minus `protectedBranches`
   * — set by `/api/runner/github-token`. When present and non-empty, the push
   * allow-list below applies: pushes and ref-writing REST/GraphQL calls that
   * touch any other ref are refused, and an unreadable push is refused too.
   * Absent (an older buildd server): only the deny-list above applies.
   */
  pushableBranches?: string[];
}

// ── Classification ────────────────────────────────────────────────────────────

export type EgressKind = 'anthropic' | 'github' | 'snapshot' | 'passthrough';

export function classifyEgressHost(hostname: string): EgressKind {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === ANTHROPIC_HOST) return 'anthropic';
  if (host === SNAPSHOT_HOST_NAME) return 'snapshot';
  if ((GITHUB_HOSTS as readonly string[]).includes(host)) return 'github';
  return 'passthrough';
}

// ── Rewrite ───────────────────────────────────────────────────────────────────

export interface OutboundRequestLike {
  url: string;
  /** The request method. Required for api.anthropic.com: without it the request is refused. */
  method?: string;
  headers: Headers | Record<string, string>;
  /**
   * A bounded, inspection-only prefix of the request body (egress.ts reads it
   * from a `request.clone()`, never the forwarded stream itself), decoded
   * byte-for-byte via `latin1Decode` so arbitrary binary never throws. Set
   * only for the two shapes that need it: a GraphQL POST to api.github.com
   * (to look for a blocked mutation name) and a `git-receive-pack` push to
   * github.com (to read the pushed ref names before the pack data starts).
   * Never used to build the forwarded request.
   */
  bodyPeek?: string;
}

/**
 * The only api.anthropic.com requests forwarded, on every model route: what
 * Claude Code sends for a run (messages, token counting, model listing).
 * Anything else is refused with 403 before a credential is added. `:id` is a
 * single model-id segment (MODEL_ID_SEGMENT_RE).
 */
export const MODEL_API_ROUTES = [
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/v1/messages/count_tokens' },
  { method: 'GET', path: '/v1/models' },
  { method: 'GET', path: '/v1/models/:id' },
] as const;

const MODEL_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The path exactly as written in the URL string, before any normalisation. */
function rawPathOf(rawUrl: string): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/.exec(rawUrl);
  return m ? (m[1] ?? null) : null;
}

/**
 * Whether a request to api.anthropic.com is one of MODEL_API_ROUTES. The path
 * must already be canonical: the raw path must equal the parsed one (no dot
 * segments, backslashes or percent-encoding for the parser to rewrite), and
 * then match a route exactly (no extra or empty segments, case-sensitive).
 */
export function modelApiPathAllowed(method: string | undefined, rawUrl: string): boolean {
  if (!method) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const path = url.pathname;
  if (rawPathOf(rawUrl) !== path || path.includes('%')) return false;
  const m = method.toUpperCase();
  return MODEL_API_ROUTES.some((r) => {
    if (r.method !== m) return false;
    if (!r.path.endsWith('/:id')) return r.path === path;
    const prefix = r.path.slice(0, -':id'.length);
    return path.startsWith(prefix) && MODEL_ID_SEGMENT_RE.test(path.slice(prefix.length));
  });
}

/** Why a request was refused (run-report.ts REJECT_REASONS). */
export type RejectReason = 'path' | 'unconfigured' | 'plain_http' | 'port' | 'unparseable' | 'merge_blocked' | 'push_not_allowed' | 'other';

/** Where a refused api.anthropic.com request was going, as a fixed label (no raw path leaves the handler). */
export type RejectedPathLabel = 'api_hello' | 'event_logging' | 'oauth' | 'claude_code_api' | 'other_api' | 'files' | 'batches' | 'other_v1' | 'other';

export function rejectedPathLabel(rawUrl: string): RejectedPathLabel {
  let p: string;
  try { p = new URL(rawUrl).pathname; } catch { return 'other'; }
  if (p === '/api/hello') return 'api_hello';
  if (p.startsWith('/api/event_logging')) return 'event_logging';
  if (p.startsWith('/api/oauth/') || p === '/api/oauth') return 'oauth';
  if (p.startsWith('/api/claude_code/') || p === '/api/claude_code') return 'claude_code_api';
  if (p.startsWith('/api/')) return 'other_api';
  if (p.startsWith('/v1/files')) return 'files';
  if (p.startsWith('/v1/messages/batches')) return 'batches';
  if (p.startsWith('/v1/')) return 'other_v1';
  return 'other';
}

export type EgressDecision =
  | { action: 'passthrough' }
  /** Answered by the handler itself; nothing leaves the Worker. */
  | { action: 'respond'; status: number }
  | {
      action: 'forward'; url: string; headers: Headers; injected: 'gateway' | 'proxy' | 'direct' | 'github_basic' | 'github_bearer' | 'otlp' | 'none';
      /** Set for a message request to a team endpoint with a model mapping: the egress handler rewrites the body's `model`. */
      mapModel?: (id: string) => string;
      /** GitHub only: why our credential did not go with this forward (counted in the run report). */
      unauthenticated?: GithubUnauthenticatedReason;
    }
  | { action: 'reject'; status: number; message: string; reason: RejectReason; pathLabel?: RejectedPathLabel };

export interface RewriteContext {
  model: ModelRoute;
  /** Resolved only for GitHub hosts. `null`: no token available, forward unauthenticated. */
  github?: GithubGrant | null;
  /** Why `github` is null, as the agent reported it (lookupGithubGrant). */
  githubUnavailable?: GithubUnavailable;
  now?: number;
}

/** Mirrors run-report.ts GITHUB_UNAUTH_REASONS. */
export type GithubUnauthenticatedReason = 'no_grant' | 'grant_fetch_failed' | 'grant_expired' | 'out_of_scope';
/** Why the agent handed back no grant: no live run, or the token fetch failed (or is backing off). */
export type GithubUnavailable = 'no_run' | 'fetch_failed';

/** Copy of the request headers with every container-supplied credential removed. */
export function stripContainerCredentials(input: Headers | Record<string, string>): Headers {
  const headers = new Headers(input as HeadersInit);
  for (const name of CONTAINER_CREDENTIAL_HEADERS) headers.delete(name);
  // The URL decides the host; a stale Host header from the original request
  // must not ride along to a different origin.
  headers.delete('host');
  return headers;
}

function base64(s: string): string {
  return btoa(s);
}

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** `/<owner>/<repo>` or `/<owner>/<repo>.git`, then end or `/`. */
function gitPathMatches(pathname: string, grant: GithubGrant): boolean {
  const [, owner, repoSeg] = pathname.split('/');
  if (!sameName(owner, grant.owner) || repoSeg === undefined) return false;
  const repo = repoSeg.toLowerCase().endsWith('.git') ? repoSeg.slice(0, -4) : repoSeg;
  return sameName(repo, grant.repo);
}

/** `/repos/<owner>/<repo>`, then end or `/`. */
function apiRepoPathMatches(pathname: string, grant: GithubGrant): boolean {
  const [, first, owner, repo] = pathname.split('/');
  return first === 'repos' && sameName(owner, grant.owner) && sameName(repo, grant.repo);
}

// ── Merge guard ───────────────────────────────────────────────────────────────
//
// buildd's own merge paths (auto-merge, reviewer approve, the `merge_pr` MCP
// action) all go through resolvePolicy()/evaluateAutoMergeSafety()/
// pr-landing.ts (docs/SPEC.md §4a) — CI gates, review verdicts, size caps,
// deny paths. The installation token this module attaches carries
// `pull_requests:write` + `contents:write`, which is also everything a
// request needs to land a PR or overwrite a branch directly, bypassing all
// of that. The three shapes below are blocked here, before any credential is
// attached, regardless of whether a usable grant exists: an agent (or
// anything running in the container) that wants a PR merged must go through
// buildd's own `merge_pr`, which applies the workspace's merge policy.
//
// Normal `git push` of the task's own branch, and PR creation/review/comment
// calls, are untouched — nothing here inspects those.

/** GitHub's REST merge endpoint: `PUT /repos/{owner}/{repo}/pulls/{number}/merge`. */
const PR_MERGE_REST_PATH_RE = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/;

function isPrMergeRestRequest(method: string | undefined, pathname: string): boolean {
  return (method ?? '').toUpperCase() === 'PUT' && PR_MERGE_REST_PATH_RE.test(pathname);
}

/** GraphQL mutations that merge a PR or arm it to merge unattended. Checked by name, not by a full GraphQL parse — see `graphqlMutationBlocked`. */
export const BLOCKED_GRAPHQL_MUTATIONS = ['mergePullRequest', 'enablePullRequestAutoMerge'] as const;

/**
 * Whether a GraphQL request body names one of `BLOCKED_GRAPHQL_MUTATIONS`.
 * Deliberately a name match, not a parsed-and-typed GraphQL AST walk: a
 * request that merely mentions the mutation name (e.g. inside an unrelated
 * string) is blocked too, and that false-positive direction is the safe one
 * — the escape hatch is always buildd's own `merge_pr`. `bodyPeek` is
 * undefined for any request egress.ts did not peek (not a POST to
 * api.github.com/graphql), so this is a no-op for everything else.
 */
export function graphqlMutationBlocked(bodyPeek: string | undefined): string | null {
  if (!bodyPeek) return null;
  for (const name of BLOCKED_GRAPHQL_MUTATIONS) {
    if (new RegExp(`\\b${name}\\b`).test(bodyPeek)) return name;
  }
  return null;
}

/**
 * Each byte becomes its own UTF-16 code unit (`TextDecoder('iso-8859-1')` —
 * never throws, unlike a UTF-8 decode of a prefix that may cut a multi-byte
 * sequence in half). Used only to read the ASCII pkt-line header of a
 * `git-receive-pack` body ahead of its binary pack data; the bytes 0x80-0x9F
 * decode differently from true Latin-1 (the Encoding Standard maps this
 * label to windows-1252), which never matters here because every byte this
 * module matches against is pure ASCII.
 */
export function latin1Decode(bytes: Uint8Array): string {
  return new TextDecoder('iso-8859-1').decode(bytes);
}

/**
 * The branch names a `git-receive-pack` request body pushes to, read from the
 * pkt-line ref-update lines at the front of the body (before the opaque,
 * binary pack data). Each line is `<4-hex-length><old-oid> <new-oid>
 * <ref>\0<capabilities>\n`; parsing stops at the flush-pkt (`0000`) that ends
 * the ref list and never looks at the pack bytes that follow. Returns `[]`
 * when nothing parses — a non-push body, a gzip-compressed one (git only
 * does this when explicitly configured; unsupported here), or a prefix cut
 * off before the flush-pkt — so an inconclusive read fails OPEN rather than
 * guessing a branch name.
 */
export function parseReceivePackPushedBranches(bodyPeek: string): string[] {
  const branches: string[] = [];
  let i = 0;
  while (i + 4 <= bodyPeek.length) {
    const lenHex = bodyPeek.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) break; // flush-pkt: end of the ref-update list
    if (len < 4 || i + len > bodyPeek.length) break; // truncated: stop rather than guess
    const line = bodyPeek.slice(i + 4, i + len);
    const m = /^[0-9a-f]{4,64} [0-9a-f]{4,64} refs\/heads\/([^\s\0]+)/.exec(line);
    const branch = m?.[1];
    if (branch) branches.push(branch);
    i += len;
  }
  return branches;
}

/** The first branch a `git-receive-pack` body pushes to that is also in `protectedBranches`, or null (including when either input is missing — fails open). */
export function pushedProtectedBranch(bodyPeek: string | undefined, protectedBranches: readonly string[] | undefined): string | null {
  if (!bodyPeek || !protectedBranches || protectedBranches.length === 0) return null;
  return parseReceivePackPushedBranches(bodyPeek).find((b) => protectedBranches.includes(b)) ?? null;
}

// ── Push allow-list ───────────────────────────────────────────────────────────
//
// GitHub cannot scope an installation token to a branch: `contents:write`
// moves every ref in the repo. When the grant names `pushableBranches`, the
// checks below narrow that to the task's own branch. Unlike the deny-list
// above they fail CLOSED: a push or ref write whose target cannot be read is
// refused, never guessed at. Reads, PR calls and git object creation (blobs,
// trees, commits, tag objects) are untouched; only ref moves are judged.

/** A ref this task may move: `refs/heads/<b>` with `<b>` in the allow-list. Tags and every other ref namespace never are. */
export function isPushableRef(ref: string, pushable: readonly string[]): boolean {
  return ref.startsWith('refs/heads/') && pushable.includes(ref.slice('refs/heads/'.length));
}

/**
 * Every ref a `git-receive-pack` body updates, read strictly: each pkt-line
 * before the flush-pkt must be a `shallow <oid>` line (a push from a shallow
 * clone) or an `<old-oid> <new-oid> <ref>` command. Anything else — an empty
 * or missing body, a compressed one, a prefix cut off before the flush-pkt, a
 * signed-push certificate — is `null`: unreadable. A bare flush-pkt (git's
 * auth probe ahead of a large push) reads as zero refs.
 */
export function parseReceivePackRefs(bodyPeek: string | undefined): string[] | null {
  if (!bodyPeek) return null;
  const refs: string[] = [];
  let i = 0;
  while (i + 4 <= bodyPeek.length) {
    const lenHex = bodyPeek.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return null;
    const len = parseInt(lenHex, 16);
    if (len === 0) return refs;
    if (len <= 4 || i + len > bodyPeek.length) return null;
    let line = bodyPeek.slice(i + 4, i + len);
    if (line.endsWith('\n')) line = line.slice(0, -1);
    i += len;
    if (/^shallow (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) continue;
    const m = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([^\0\s]+)(?:\0[\s\S]*)?$/.exec(line);
    if (!m) return null;
    refs.push(m[1]!);
  }
  return null; // no flush-pkt within the peek
}

/** Why a push is refused under the allow-list (the first ref outside it, or that the body was unreadable), or null when every updated ref is pushable. */
export function pushOutsideAllowList(bodyPeek: string | undefined, pushable: readonly string[]): string | null {
  const refs = parseReceivePackRefs(bodyPeek);
  if (refs === null) return 'an unreadable push';
  const bad = refs.find((r) => !isPushableRef(r, pushable));
  return bad ? `'${bad}'` : null;
}

/**
 * How a REST call on `api.github.com/repos/<owner>/<repo>/...` moves a ref, or
 * null when it moves none:
 *   - `path`: the ref is in the URL (`/git/refs/<ref>`)
 *   - `body`: the ref is a JSON body field (`ref` is fully qualified; `branch`
 *     and `base` are branch names, and a missing one means the default branch)
 *   - `refuse`: the target ref cannot be told from the request alone
 *     (branch rename, a PR's update-branch, release create/edit, which can
 *     create a tag ref), or the path does not decode
 * The path is percent-decoded and slash-collapsed first, and route segments
 * match case-insensitively, so a spelling GitHub would still route is judged.
 */
export type RepoRefWrite =
  | { check: 'path'; ref: string }
  | { check: 'body'; field: 'ref' | 'branch' | 'base' }
  | { check: 'refuse' };

export function classifyRepoRefWrite(method: string | undefined, pathname: string): RepoRefWrite | null {
  const verb = (method ?? '').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return null;
  if (!/^\/+repos\//i.test(pathname)) return null;
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return { check: 'refuse' };
  }
  p = p.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const rest = /^\/repos\/[^/]+\/[^/]+\/(.+)$/i.exec(p)?.[1];
  if (!rest) return null;
  if (/^git\/refs$/i.test(rest)) return verb === 'POST' ? { check: 'body', field: 'ref' } : null;
  const ref = /^git\/refs\/(.+)$/i.exec(rest)?.[1];
  if (ref) return { check: 'path', ref: `refs/${ref}` };
  if (/^contents(?:\/.*)?$/i.test(rest)) return verb === 'PUT' || verb === 'DELETE' ? { check: 'body', field: 'branch' } : null;
  if (/^merges$/i.test(rest)) return verb === 'POST' ? { check: 'body', field: 'base' } : null;
  if (/^merge-upstream$/i.test(rest)) return verb === 'POST' ? { check: 'body', field: 'branch' } : null;
  if (/^branches\/.+\/rename$/i.test(rest)) return { check: 'refuse' };
  if (/^pulls\/[^/]+\/update-branch$/i.test(rest)) return { check: 'refuse' };
  if (/^releases$/i.test(rest)) return verb === 'POST' ? { check: 'refuse' } : null;
  if (/^releases\/[^/]+$/i.test(rest)) return verb === 'PATCH' ? { check: 'refuse' } : null;
  return null;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null; // not JSON, or a prefix cut off by the peek bound
  }
}

/** Why a REST ref write is refused under the allow-list, or null when it targets a pushable branch. */
export function repoRefWriteOutsideAllowList(write: RepoRefWrite, bodyPeek: string | undefined, pushable: readonly string[]): string | null {
  if (write.check === 'refuse') return 'this ref operation';
  if (write.check === 'path') return isPushableRef(write.ref, pushable) ? null : `'${write.ref}'`;
  const body = parseJsonObject(bodyPeek);
  if (!body) return 'an unreadable request body';
  const value = body[write.field];
  if (typeof value !== 'string' || !value) return write.field === 'ref' ? 'a ref write with no ref' : 'the default branch';
  const ref = write.field === 'ref' ? value : value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
  return isPushableRef(ref, pushable) ? null : `'${ref}'`;
}

/**
 * GraphQL mutations that move a ref. Several name the ref only by an opaque
 * node id (`updateRef`, `deleteRef`, a `createCommitOnBranch` branch id), so
 * the target cannot be read from the request: under the allow-list these are
 * refused by name, outright, whatever branch they name. Pushing with git is
 * unaffected.
 */
export const REF_GRAPHQL_MUTATIONS = [
  'createRef', 'updateRef', 'updateRefs', 'deleteRef', 'createCommitOnBranch',
  'mergeBranch', 'updatePullRequestBranch', 'revertPullRequest', 'createLinkedBranch',
] as const;

/**
 * Why a GraphQL request is refused under the allow-list, or null. The body
 * must parse as a JSON object with a string `query` (an unreadable or
 * truncated body is refused), and the mutation names are matched against both
 * the raw text and the decoded `query`, so a JSON string escape does not hide
 * one. The merge mutations are re-checked on the decoded query for the same
 * reason.
 */
export function graphqlOutsideAllowList(bodyPeek: string | undefined): { reason: RejectReason; what: string } | null {
  const query = parseJsonObject(bodyPeek)?.query;
  if (typeof query !== 'string') return { reason: 'push_not_allowed', what: 'an unreadable GraphQL request' };
  if (graphqlMutationBlocked(query)) return { reason: 'merge_blocked', what: 'a merge mutation' };
  for (const name of REF_GRAPHQL_MUTATIONS) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(query) || re.test(bodyPeek ?? '')) return { reason: 'push_not_allowed', what: `the ${name} mutation` };
  }
  return null;
}

const pushNotAllowedMessage = (what: string, pushable: readonly string[]): string =>
  `${what} is outside this task's branch on this egress — agents may update only ${pushable.map((b) => `'${b}'`).join(', ')}; open a PR from it and land it with buildd's merge_pr MCP action`;

/**
 * Whether egress.ts should peek this request's body before deciding: a
 * GraphQL call to api.github.com, or a push to github.com. Both bound how
 * much is read (GITHUB_BODY_PEEK_MAX_BYTES in egress.ts); everything else is
 * forwarded untouched with no peek at all.
 */
export function needsGithubBodyPeek(hostname: string, method: string | undefined, pathname: string): boolean {
  const host = hostname.toLowerCase();
  // A REST ref write whose target ref is a body field (push allow-list).
  if (host === 'api.github.com' && classifyRepoRefWrite(method, pathname)?.check === 'body') return true;
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  if (host === 'api.github.com') return pathname === '/graphql';
  if (host === 'github.com') return pathname.endsWith('/git-receive-pack');
  return false;
}

/** Points the agent at the one path that still applies buildd's merge policy. */
const MERGE_VIA_BUILDD_MESSAGE =
  'direct GitHub merges are blocked for agents on this egress — use buildd\'s merge_pr MCP action so the workspace merge policy is enforced';

const pushBlockedMessage = (branch: string): string =>
  `direct pushes to '${branch}' are blocked for agents on this egress — push your task branch, open a PR, and land it with buildd's merge_pr MCP action`;

/**
 * Whether the installation token is attached to this GitHub request.
 *
 * Scoping achieved, in layers:
 *  1. GitHub itself: the token is minted with `repository_ids: [<task repo>]`,
 *     so it authorizes nothing outside that one repo whatever it is sent with.
 *  2. Here: on github.com and uploads/api repo paths the token is added only
 *     when the path names the task's `<owner>/<repo>`. A clone of any other
 *     repo goes out unauthenticated (public repos still work).
 *  3. `api.github.com/graphql` cannot be scoped by path (the repo is in the
 *     body), so it gets the token and relies on layer 1. `gh pr create` and
 *     friends need it.
 * Any other api.github.com path (`/user`, `/search`, `/orgs/...`) gets none.
 */
export function githubAuthFor(url: URL, grant: GithubGrant): 'github_basic' | 'github_bearer' | 'none' {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'github.com') return gitPathMatches(path, grant) ? 'github_basic' : 'none';
  if (host === 'api.github.com') {
    if (path === '/graphql') return 'github_bearer';
    return apiRepoPathMatches(path, grant) ? 'github_bearer' : 'none';
  }
  if (host === 'uploads.github.com') return apiRepoPathMatches(path, grant) ? 'github_bearer' : 'none';
  // codeload serves archives behind signed redirects from api.github.com; it
  // needs no token of ours.
  return 'none';
}

/**
 * Decide what to do with one outbound request. Pure: the handler does the
 * I/O (fetching the GitHub grant, forwarding the request).
 */
export function rewriteOutbound(req: OutboundRequestLike, ctx: RewriteContext): EgressDecision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { action: 'reject', status: 400, message: 'unparseable request URL', reason: 'unparseable' };
  }
  const kind = classifyEgressHost(url.hostname);
  if (kind === 'passthrough') return { action: 'passthrough' };
  // Served in the Worker by the snapshot store; forwarding it would send the
  // container's snapshot bytes to whatever that name resolves to.
  if (kind === 'snapshot') return { action: 'reject', status: 404, message: 'the snapshot host is not forwarded', reason: 'other' };

  // Credentialed hosts are HTTPS only: a plaintext request is refused rather
  // than upgraded, so nothing credentialed is ever built from it.
  if (url.protocol !== 'https:') {
    return { action: 'reject', status: 403, message: `${url.hostname} is reachable only over HTTPS`, reason: 'plain_http' };
  }
  if (url.port && url.port !== '443') {
    return { action: 'reject', status: 403, message: `${url.hostname}: only port 443 is allowed`, reason: 'port' };
  }

  const headers = stripContainerCredentials(req.headers);
  // Credentials in the URL itself (`https://user:token@github.com/...`) are
  // container-supplied too.
  url.username = '';
  url.password = '';

  if (kind === 'anthropic') {
    // Claude Code's connectivity check (HEAD /api/hello at start-up). It
    // carries nothing and needs no credential: answer it here rather than
    // refuse it (a refusal reads as "offline") or forward it to an endpoint
    // that does not serve it.
    if ((req.method === 'HEAD' || req.method === 'GET') && url.pathname === '/api/hello' && !url.search) {
      return { action: 'respond', status: 200 };
    }
    // Judged on the original URL string, before anything is added.
    if (!modelApiPathAllowed(req.method, req.url)) {
      return { action: 'reject', status: 403, message: `${ANTHROPIC_HOST}: only the model API paths are forwarded`, reason: 'path', pathLabel: rejectedPathLabel(req.url) };
    }
    const route = ctx.model;
    if (route.kind === 'unconfigured') {
      return { action: 'reject', status: 503, message: `model egress is not configured: ${route.reason}`, reason: 'unconfigured' };
    }
    if (route.kind === 'direct') {
      headers.set('x-api-key', route.apiKey);
      return { action: 'forward', url: url.toString(), headers, injected: 'direct' };
    }
    if (route.kind === 'proxy') {
      // Container credentials are already stripped; this is the only one added.
      headers.set(route.authHeader, route.authHeader === 'authorization' ? `Bearer ${route.key}` : route.key);
      const mapModel = route.mapModel && isModelRewritePath(req.method, req.url) ? route.mapModel : undefined;
      return { action: 'forward', url: `${route.baseUrl}${url.pathname}${url.search}`, headers, injected: 'proxy', ...(mapModel ? { mapModel } : {}) };
    }
    headers.set('cf-aig-authorization', `Bearer ${route.token}`);
    return { action: 'forward', url: `${route.baseUrl}${url.pathname}${url.search}`, headers, injected: 'gateway' };
  }

  // GitHub
  if (isPrMergeRestRequest(req.method, url.pathname)) {
    return { action: 'reject', status: 403, message: MERGE_VIA_BUILDD_MESSAGE, reason: 'merge_blocked' };
  }
  if (url.hostname.toLowerCase() === 'api.github.com' && url.pathname === '/graphql' && (req.method ?? '').toUpperCase() === 'POST') {
    if (graphqlMutationBlocked(req.bodyPeek)) {
      return { action: 'reject', status: 403, message: MERGE_VIA_BUILDD_MESSAGE, reason: 'merge_blocked' };
    }
  }
  const grant = ctx.github;
  const now = ctx.now ?? Date.now();
  const usable = grant && grant.token && grant.expiresAt > now ? grant : null;
  if (usable && url.hostname.toLowerCase() === 'github.com' && (req.method ?? '').toUpperCase() === 'POST' && url.pathname.endsWith('/git-receive-pack')) {
    const branch = pushedProtectedBranch(req.bodyPeek, usable.protectedBranches);
    if (branch) return { action: 'reject', status: 403, message: pushBlockedMessage(branch), reason: 'merge_blocked' };
  }
  const pushable = usable?.pushableBranches?.length ? usable.pushableBranches : null;
  if (pushable) {
    const host = url.hostname.toLowerCase();
    const verb = (req.method ?? '').toUpperCase();
    let refused: { reason: RejectReason; what: string } | null = null;
    if (host === 'github.com' && verb === 'POST' && url.pathname.endsWith('/git-receive-pack')) {
      const what = pushOutsideAllowList(req.bodyPeek, pushable);
      if (what) refused = { reason: 'push_not_allowed', what };
    } else if (host === 'api.github.com' && url.pathname === '/graphql' && verb === 'POST') {
      refused = graphqlOutsideAllowList(req.bodyPeek);
    } else if (host === 'api.github.com') {
      const write = classifyRepoRefWrite(req.method, url.pathname);
      const what = write ? repoRefWriteOutsideAllowList(write, req.bodyPeek, pushable) : null;
      if (what) refused = { reason: 'push_not_allowed', what };
    }
    if (refused) {
      const message = refused.reason === 'merge_blocked' ? MERGE_VIA_BUILDD_MESSAGE : pushNotAllowedMessage(refused.what, pushable);
      return { action: 'reject', status: 403, message, reason: refused.reason };
    }
  }
  const auth = usable ? githubAuthFor(url, usable) : 'none';
  if (usable && auth === 'github_basic') {
    headers.set('authorization', `Basic ${base64(`x-access-token:${usable.token}`)}`);
  } else if (usable && auth === 'github_bearer') {
    headers.set('authorization', `Bearer ${usable.token}`);
  }
  if (auth !== 'none') return { action: 'forward', url: url.toString(), headers, injected: auth };
  const unauthenticated: GithubUnauthenticatedReason = usable
    ? 'out_of_scope'
    : grant ? 'grant_expired'
    : ctx.githubUnavailable === 'fetch_failed' ? 'grant_fetch_failed' : 'no_grant';
  return { action: 'forward', url: url.toString(), headers, injected: auth, unauthenticated };
}

// ── Token cache (lives in the WorkerAgent) ────────────────────────────────────

/** Refetch this long before GitHub's stated expiry. */
export const GITHUB_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** After a failed fetch, don't ask again for this long (a clone makes many requests). */
export const GITHUB_TOKEN_FAILURE_BACKOFF_MS = 15 * 1000;

export interface GithubTokenCacheDeps {
  fetchGrant(): Promise<GithubGrant>;
  now(): number;
  log?(message: string): void;
  /** Once per failed fetch: buildd's status (GrantFetchError), or 0 when nothing answered. */
  onFailure?(status: number): void;
}

/** buildd's github-token endpoint answered `status` instead of a grant. */
export class GrantFetchError extends Error {
  constructor(readonly status: number, detail?: string) {
    super(`${GITHUB_TOKEN_PATH} returned ${status}${detail ? `: ${detail}` : ''}`);
  }
}

/** What the agent's grant RPC hands the egress handler: the grant, or why there is none. */
export type GithubGrantLookup = { grant: GithubGrant } | { grant: null; unavailable: GithubUnavailable };

/** The agent's grant RPC. `live`: a run is starting or running; only then is the cache asked. */
export async function lookupGithubGrant(live: boolean, get: () => Promise<GithubGrant | null>): Promise<GithubGrantLookup> {
  if (!live) return { grant: null, unavailable: 'no_run' };
  const grant = await get();
  return grant ? { grant } : { grant: null, unavailable: 'fetch_failed' };
}

/**
 * The agent's copy of the installation token. In memory only: never written
 * to Durable Object storage and never passed to the container. Concurrent
 * callers share one in-flight fetch; the token is refetched once it is within
 * GITHUB_TOKEN_REFRESH_MARGIN_MS of expiry, so a run longer than the token's
 * ~60 min life keeps working. A failure yields `null` (the request goes out
 * unauthenticated) and is not retried for GITHUB_TOKEN_FAILURE_BACKOFF_MS.
 */
export class GithubTokenCache {
  private grant: GithubGrant | null = null;
  private inflight: Promise<GithubGrant | null> | null = null;
  private failedAt: number | null = null;
  private generation = 0;

  constructor(private readonly d: GithubTokenCacheDeps) {}

  /** Forget everything; called at the start of each run. */
  reset(): void {
    this.grant = null;
    this.inflight = null;
    this.failedAt = null;
    this.generation++;
  }

  async get(): Promise<GithubGrant | null> {
    const now = this.d.now();
    if (this.grant && this.grant.expiresAt - GITHUB_TOKEN_REFRESH_MARGIN_MS > now) return this.grant;
    if (this.inflight) return this.inflight;
    if (this.failedAt !== null && now - this.failedAt < GITHUB_TOKEN_FAILURE_BACKOFF_MS) return null;
    const gen = this.generation;
    const p = this.d.fetchGrant().then(
      (grant) => {
        if (gen !== this.generation) return null;
        this.grant = grant;
        this.failedAt = null;
        return grant;
      },
      (err) => {
        if (gen !== this.generation) return null;
        this.grant = null;
        this.failedAt = this.d.now();
        const status = err instanceof GrantFetchError ? err.status : 0;
        this.d.log?.(`[cloud-runner] GitHub token fetch failed (status ${status || 'none'}): ${err instanceof Error ? err.message : String(err)}`);
        this.d.onFailure?.(status);
        return null;
      },
    ).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }
}

/** Parse and validate the buildd endpoint's JSON. Throws on anything unexpected. */
export function parseGithubGrant(body: unknown): GithubGrant {
  const b = body as { token?: unknown; expiresAt?: unknown; repository?: { owner?: unknown; name?: unknown } } | null;
  const token = b?.token;
  const expiresAt = typeof b?.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
  const owner = b?.repository?.owner;
  const repo = b?.repository?.name;
  if (typeof token !== 'string' || !token) throw new Error('github-token response has no token');
  if (!Number.isFinite(expiresAt)) throw new Error('github-token response has no valid expiresAt');
  if (typeof owner !== 'string' || !owner || typeof repo !== 'string' || !repo) {
    throw new Error('github-token response has no repository owner/name');
  }
  const ws = (b as { workspaceId?: unknown } | null)?.workspaceId;
  const grant: GithubGrant = { token, expiresAt, owner, repo };
  if (typeof ws === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ws)) grant.workspaceId = ws;
  const cap = (b as { warmSnapshotMaxBytes?: unknown } | null)?.warmSnapshotMaxBytes;
  if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0) grant.warmSnapshotMaxBytes = cap;
  const rawProtected = (b as { protectedBranches?: unknown } | null)?.protectedBranches;
  if (Array.isArray(rawProtected)) {
    const branches = rawProtected.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255).slice(0, 50);
    if (branches.length > 0) grant.protectedBranches = branches;
  }
  const rawPushable = (b as { pushableBranches?: unknown } | null)?.pushableBranches;
  if (Array.isArray(rawPushable)) {
    const branches = rawPushable.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255).slice(0, 50);
    if (branches.length > 0) grant.pushableBranches = branches;
  }
  return grant;
}

// ── Server model endpoint cache (lives in the WorkerAgent) ────────────────────

/** After a failed fetch or a 401 from the endpoint, don't ask again for this long. */
export const MODEL_ENDPOINT_FAILURE_BACKOFF_MS = 10 * 1000;

/** Thrown by a fetcher when buildd answers 404: this task has no endpoint. */
export class NoModelEndpointError extends Error {
  constructor() { super('no agent model endpoint for this task'); }
}

export interface ModelEndpointCacheDeps {
  /** Resolves the endpoint, or throws NoModelEndpointError on a 404. */
  fetchEndpoint(): Promise<ServerModelEndpoint>;
  now(): number;
  log?(message: string): void;
}

/**
 * The agent's copy of the team's model endpoint for one run. In memory only:
 * never in Durable Object storage and never in the container env. Fetched on
 * the first model request; concurrent callers share one in-flight fetch. A
 * 404 is an answer ("none", cached for the run: egress falls through to the
 *  Worker's own route). Any other failure, and a 401 from the endpoint
 * (`invalidate`), yields `'unavailable'` for MODEL_ENDPOINT_FAILURE_BACKOFF_MS
 * and then refetches.
 */
export class ModelEndpointCache {
  private value: ServerModelEndpoint | null | undefined = undefined;
  private inflight: Promise<ServerModelEndpointState> | null = null;
  private failedAt: number | null = null;
  private generation = 0;

  constructor(private readonly d: ModelEndpointCacheDeps) {}

  /** Forget everything; called at the start of each run. */
  reset(): void {
    this.value = undefined;
    this.inflight = null;
    this.failedAt = null;
    this.generation++;
  }

  /** The endpoint rejected its key: drop it and refetch after the backoff. */
  invalidate(): void {
    if (this.value) this.d.log?.('[cloud-runner] agent model endpoint rejected its key; refetching after backoff');
    this.value = undefined;
    this.inflight = null;
    this.failedAt = this.d.now();
    this.generation++;
  }

  async get(): Promise<ServerModelEndpointState> {
    if (this.value !== undefined) return this.value;
    if (this.inflight) return this.inflight;
    if (this.failedAt !== null && this.d.now() - this.failedAt < MODEL_ENDPOINT_FAILURE_BACKOFF_MS) return 'unavailable';
    const gen = this.generation;
    const p: Promise<ServerModelEndpointState> = this.d.fetchEndpoint().then(
      (endpoint) => {
        if (gen !== this.generation) return 'unavailable' as const;
        this.value = endpoint;
        this.failedAt = null;
        return endpoint;
      },
      (err) => {
        if (gen !== this.generation) return 'unavailable' as const;
        if (err instanceof NoModelEndpointError) {
          this.value = null;
          this.failedAt = null;
          return null;
        }
        this.failedAt = this.d.now();
        this.d.log?.(`[cloud-runner] agent model endpoint fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return 'unavailable' as const;
      },
    ).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }
}

/**
 * Parse and validate the buildd endpoint's JSON. Throws on anything
 * unexpected. `{ source: 'anthropic_api_key', key }` is the task's own
 * Anthropic key (docs/credentials-architecture.md): `baseUrl`/`authHeader`
 * are not on the wire, only implied (`api.anthropic.com` / `x-api-key`), so
 * resolveModelRoute can treat it as an ordinary `proxy` route while still
 * recognising `source` to rank it ahead of MODEL_PROXY_URL.
 */
export function parseServerModelEndpoint(body: unknown): ServerModelEndpoint {
  const withSource = body as { source?: unknown; key?: unknown } | null;
  if (withSource?.source === 'anthropic_api_key') {
    if (typeof withSource.key !== 'string' || !withSource.key) {
      throw new Error('model-endpoint response has no key');
    }
    return { source: 'anthropic_api_key', baseUrl: `https://${ANTHROPIC_HOST}`, key: withSource.key, authHeader: 'x-api-key' };
  }
  const b = body as { baseUrl?: unknown; key?: unknown; authHeader?: unknown } | null;
  if (typeof b?.baseUrl !== 'string') throw new Error('model-endpoint response has no baseUrl');
  const parsed = parseModelProxyUrl(b.baseUrl);
  if (!parsed.ok) throw new Error(`model-endpoint response: ${parsed.error.replace(/MODEL_PROXY_URL/g, 'baseUrl')}`);
  if (typeof b.key !== 'string' || !b.key) throw new Error('model-endpoint response has no key');
  const authHeader = parseModelProxyAuthHeader(typeof b.authHeader === 'string' ? b.authHeader : undefined);
  if (!authHeader || (b.authHeader !== undefined && typeof b.authHeader !== 'string')) {
    throw new Error('model-endpoint response authHeader must be authorization or x-api-key');
  }
  const raw = (body as { kind?: unknown; models?: unknown }) ?? {};
  const models: Record<string, string> = {};
  if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
    for (const [k, v] of Object.entries(raw.models as Record<string, unknown>).slice(0, MAX_MODEL_ALIASES)) {
      if (k && typeof v === 'string' && v) models[k] = v;
    }
  }
  return {
    baseUrl: parsed.baseUrl, key: b.key, authHeader, models,
    ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
  };
}

const MAX_MODEL_ALIASES = 200;

/**
 * The model id to send to the team endpoint for a native id: the same rule as
 * buildd core's mapAgentModel (packages/core/agent-endpoint.ts), which host
 * runners apply through ANTHROPIC_*_MODEL env vars. A cloud container gets no
 * endpoint details, so the egress handler applies it to the request body.
 * OpenRouter names Anthropic models `anthropic/<undated id, minor version
 * dotted>` (packages/ai-kit openRouterModelId); everything else uses aliases.
 */
export function mapEndpointModel(endpoint: { kind?: string; models?: Record<string, string> }, id: string): string {
  if (endpoint.kind === 'openrouter') {
    if (id.includes('/')) return id;
    return `anthropic/${id.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  }
  return endpoint.models?.[id] ?? id;
}

/** The requests whose JSON body names a model: messages and token counting. */
export function isModelRewritePath(method: string | undefined, rawUrl: string): boolean {
  if (method !== 'POST') return false;
  try {
    const p = new URL(rawUrl).pathname;
    return p === '/v1/messages' || p === '/v1/messages/count_tokens';
  } catch {
    return false;
  }
}

/** Whether an endpoint model id names a Claude model (any provider prefix). */
export function isClaudeModelId(id: string): boolean {
  return /(^|[/.])claude-/i.test(id) || /^claude/i.test(id);
}

/**
 * The Messages API's standard top-level fields. Claude Code also sends
 * Anthropic-only ones (`context_management`, `output_config`, `diagnostics`,
 * ...), which a proxy passes through and a non-Anthropic model behind it
 * rejects ("Extra inputs are not permitted").
 */
const STANDARD_MESSAGE_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'metadata', 'stop_sequences', 'stream',
  'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'thinking',
]);

/**
 * The body with its top-level `model` mapped; null when it is not a JSON
 * object or nothing changes. When the target is not a Claude model, only the
 * standard Messages API fields are kept.
 */
export function rewriteModelInBody(text: string, map: (id: string) => string): string | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== 'string') return null;
  const mapped = map(model);
  if (mapped === model) return null;
  const fields = Object.entries(body as Record<string, unknown>)
    .filter(([k]) => isClaudeModelId(mapped) || STANDARD_MESSAGE_FIELDS.has(k));
  return JSON.stringify({ ...Object.fromEntries(fields), model: mapped });
}

/**
 * Whether an endpoint answer means its key is bad. Only 401: a 403 is a
 * per-request refusal (LiteLLM answers 403 for a model the key may not use),
 * and treating it as a dead key would refuse every request, the agent's main
 * model included, until the backoff ends.
 */
export function endpointRejectedKey(status: number): boolean {
  return status === 401;
}

// ── buildd request ────────────────────────────────────────────────────────────

/** Header carrying DISPATCH_TOKEN on the token request. Mirrors the buildd route. */
export const DISPATCH_TOKEN_HEADER = 'X-Buildd-Dispatch-Token';
export const GITHUB_TOKEN_PATH = '/api/runner/github-token';

/**
 * The agent's request for a repo-scoped installation token. Two credentials:
 * the runner API key (the account that claimed the task) and DISPATCH_TOKEN,
 * which the container never has. Without the second, the container could
 * call this endpoint with its own BUILDD_API_KEY and get the token directly.
 */
export function githubTokenRequest(cfg: {
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  DISPATCH_TOKEN?: string;
}, taskId: string, workerId?: string): { url: string; init: RequestInit } {
  if (!cfg.BUILDD_SERVER || !cfg.BUILDD_API_KEY || !cfg.DISPATCH_TOKEN) {
    throw new Error('BUILDD_SERVER, BUILDD_API_KEY and DISPATCH_TOKEN are needed to fetch a GitHub token');
  }
  return {
    url: `${cfg.BUILDD_SERVER.replace(/\/+$/, '')}${GITHUB_TOKEN_PATH}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.BUILDD_API_KEY}`,
        [DISPATCH_TOKEN_HEADER]: cfg.DISPATCH_TOKEN,
      },
      body: JSON.stringify(workerId ? { taskId, workerId } : { taskId }),
    },
  };
}

export const MODEL_ENDPOINT_PATH = '/api/runner/model-endpoint';

/** The agent's request for the team's model endpoint. Same two credentials as githubTokenRequest. */
export function modelEndpointRequest(cfg: {
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  DISPATCH_TOKEN?: string;
}, taskId: string, workerId?: string): { url: string; init: RequestInit } {
  if (!cfg.BUILDD_SERVER || !cfg.BUILDD_API_KEY || !cfg.DISPATCH_TOKEN) {
    throw new Error('BUILDD_SERVER, BUILDD_API_KEY and DISPATCH_TOKEN are needed to fetch the model endpoint');
  }
  return {
    url: `${cfg.BUILDD_SERVER.replace(/\/+$/, '')}${MODEL_ENDPOINT_PATH}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.BUILDD_API_KEY}`,
        [DISPATCH_TOKEN_HEADER]: cfg.DISPATCH_TOKEN,
      },
      body: JSON.stringify(workerId ? { taskId, workerId } : { taskId }),
    },
  };
}

// ── Local debug echo ──────────────────────────────────────────────────────────

/**
 * With the var EGRESS_DEBUG_ECHO=1 (local smoke only), the handler answers
 * with this description instead of forwarding. Header values are replaced by
 * a short SHA-256 fingerprint, so the echo proves which credential was set
 * without ever printing one, and leaks nothing if the var is set by mistake.
 */
export async function describeForwardForDebug(
  d: Extract<EgressDecision, { action: 'forward' }>,
): Promise<{ url: string; injected: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  for (const [name, value] of d.headers) headers[name] = await fingerprint(value);
  return { url: d.url, injected: d.injected, headers };
}

export async function fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return `sha256:${Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('')}`;
}
