/**
 * The kernel command API, version 1 (docs/specs/workflow-kernel-library.md §3):
 * the service boundary between the doors (which may run on Vercel) and the one
 * host that applies kernel commands and drains effects (the execution control
 * plane, apps/control-plane).
 *
 * `POST /v1/commands` on the control plane's own hostname. The body names one
 * door operation (`op`), its input, the principal the calling host vouches for
 * and a caller-supplied idempotency key:
 *
 *   { v: 1, op: 'land', input: {...}, principal: { kind: 'user', id }, idempotencyKey }
 *
 * and is answered with the operation's result and the delivery's version:
 *
 *   { v: 1, op, idempotencyKey, result, delivery: { id, version } | null, host, replayed }
 *
 * - Authenticated: the request is signed (HMAC over timestamp, method, path and
 *   body, the scheme Dispatch callbacks use, `@buildd/dispatch-contract`) with
 *   the dedicated command key ring `KERNEL_COMMAND_SECRET` (required: with it
 *   unset every request is refused), and the principal it names must still reach the
 *   workspace it acts on (team membership for a person, workspace reach for an
 *   API account). The door already authorised the action; this re-checks who it
 *   is for, so a signed request can act only for someone who could have.
 * - Idempotent: the key is claimed in Postgres (`workflow_commands`,
 *   command-ledger.ts) before anything runs. A second request with the key
 *   waits for the first and gets its stored answer (`replayed: true`); the
 *   same key with a different request is refused.
 * - Only the host: a process that is not the control plane in `own` mode
 *   answers 409 `not_host` and applies nothing, so in `shadow` the web host
 *   keeps running the package itself and the two never both apply.
 *
 * The operations are the seam's door functions (seam.ts), unchanged: the same
 * code runs here, and on the web host in shadow (kernel-client.ts).
 */
import { verifyRequest } from '@buildd/dispatch-contract';
import { commandKeyRing } from './command-keys';
import type { DrainSummary } from './effects';
import { kernelHost } from './kernel-host';
import { postgresCommandLedger, type CommandLedger, type StoredAnswer } from './command-ledger';

export const COMMAND_API_VERSION = 1;
export const COMMAND_PATH = '/v1/commands';

type Seam = typeof import('./seam');

/**
 * Who the calling host vouches for, carrying what the control plane needs to apply the same
 * workspace reach rule as the web host (lib/team-access.ts):
 *  - `user`: a person signed in to the dashboard, judged by team membership;
 *  - `account`: an API account that is NOT a grant session, judged by the account row. A host
 *    sends `grant: null` to say so; a principal without it comes from a host that predates
 *    grant principals and cannot tell a grant session from its team's shared account;
 *  - `grant`: an account-level grant session. It acts as its team's shared session account (`id`)
 *    but reaches only the workspaces on its grant, as the web host resolved them for this
 *    request (`workspaceIds`), with the grant's scopes. A control plane that predates this kind
 *    refuses it as malformed, so it fails closed.
 *  - `system`: buildd's own sweeps and rules, never a person or an agent run.
 */
export type KernelPrincipal =
  | { kind: 'user'; id: string }
  | { kind: 'account'; id: string; grant?: null }
  | { kind: 'grant'; id: string; grantId: string; workspaceIds: string[]; scopes: string[]; userId?: string | null }
  | { kind: 'system'; id: string };

/** The v1 operations: each is one seam door function, its input and its result. */
export interface KernelOps {
  land: { input: Parameters<Seam['landThroughKernel']>[0]; result: Awaited<ReturnType<Seam['landThroughKernel']>> };
  apply_recommendation: { input: Parameters<Seam['applyRecommendationThroughKernel']>[0]; result: Awaited<ReturnType<Seam['applyRecommendationThroughKernel']>> };
  policy_merge: { input: Parameters<Seam['policyMergeThroughKernel']>[0]; result: Awaited<ReturnType<Seam['policyMergeThroughKernel']>> };
  request_review: { input: Parameters<Seam['requestReview']>[0]; result: Awaited<ReturnType<Seam['requestReview']>> };
  request_ci_retry: { input: Parameters<Seam['requestCiRetry']>[0]; result: Awaited<ReturnType<Seam['requestCiRetry']>> };
  record_supersession: { input: Parameters<Seam['recordSupersession']>[0]; result: Awaited<ReturnType<Seam['recordSupersession']>> };
  abandon: { input: Parameters<Seam['abandonDelivery']>[0]; result: Awaited<ReturnType<Seam['abandonDelivery']>> };
  open_delivery: { input: Parameters<Seam['openKernelDelivery']>[0]; result: Awaited<ReturnType<Seam['openKernelDelivery']>> };
  /** Drain one delivery's due effects: what a web-host caller asks for instead of draining inline. */
  drain: { input: { deliveryId: string }; result: DrainSummary | null };
}
export type KernelOp = keyof KernelOps;

const RUN: { [K in KernelOp]: (seam: Seam, input: KernelOps[K]['input']) => Promise<KernelOps[K]['result']> } = {
  land: (s, i) => s.landThroughKernel(i),
  apply_recommendation: (s, i) => s.applyRecommendationThroughKernel(i),
  policy_merge: (s, i) => s.policyMergeThroughKernel(i),
  request_review: (s, i) => s.requestReview(i),
  request_ci_retry: (s, i) => s.requestCiRetry(i),
  record_supersession: (s, i) => s.recordSupersession(i),
  abandon: (s, i) => s.abandonDelivery(i),
  open_delivery: (s, i) => s.openKernelDelivery(i),
  drain: (s, i) => s.drainDelivery(i.deliveryId),
};

export const KERNEL_OPS = Object.keys(RUN) as KernelOp[];
export const isKernelOp = (v: unknown): v is KernelOp => typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUN, v);

/** Run one operation on this host: the code both the endpoint and a shadow-mode door run. */
export async function runKernelOp<K extends KernelOp>(op: K, input: KernelOps[K]['input']): Promise<KernelOps[K]['result']> {
  const seam = await import('./seam');
  return (RUN[op] as (s: Seam, i: KernelOps[K]['input']) => Promise<KernelOps[K]['result']>)(seam, input);
}

export interface DeliveryVersion { id: string; version: number }

/** The delivery the operation acted on, as it stands now: the version every answer carries. */
export async function deliveryAfter(op: KernelOp, input: unknown, result: unknown): Promise<DeliveryVersion | null> {
  const i = (input ?? {}) as Record<string, unknown>;
  const { kernelDeliveryOfPr } = await import('./seam');
  const { loadView } = await import('./kernel');
  const byId = async (deliveryId: string): Promise<DeliveryVersion | null> => {
    const d = (await loadView({ deliveryId })).delivery;
    return d ? { id: d.id, version: d.version } : null;
  };
  if (op === 'drain' && typeof i.deliveryId === 'string') return byId(i.deliveryId);
  if (op === 'open_delivery') {
    const id = (result as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof id === 'string') return byId(id);
  }
  if (typeof i.workspaceId === 'string' && typeof i.prNumber === 'number') {
    const d = await kernelDeliveryOfPr({ workspaceId: i.workspaceId, prNumber: i.prNumber });
    return d ? { id: d.deliveryId, version: d.version } : null;
  }
  return null;
}

// ── Request shape ───────────────────────────────────────────────────────────

export interface CommandRequest<K extends KernelOp = KernelOp> {
  v: typeof COMMAND_API_VERSION;
  op: K;
  input: KernelOps[K]['input'];
  principal: KernelPrincipal;
  idempotencyKey: string;
}

export interface CommandAnswer<K extends KernelOp = KernelOp> {
  v: typeof COMMAND_API_VERSION;
  op: K;
  idempotencyKey: string;
  result: KernelOps[K]['result'];
  delivery: DeliveryVersion | null;
  /** The host that applied it. */
  host: 'control-plane' | 'web';
  /** True when this answer is the stored one from an earlier request with the key. */
  replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9:._\-]{8,200}$/;

const MAX_GRANT_WORKSPACES = 500;

function isPrincipal(p: unknown): p is KernelPrincipal {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  const { kind, id } = r;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false;
  if (kind === 'user') return UUID.test(id);
  if (kind === 'account') return UUID.test(id) && (!('grant' in r) || r.grant === null);
  if (kind === 'grant') {
    return UUID.test(id)
      && typeof r.grantId === 'string' && r.grantId.length > 0 && r.grantId.length <= 200
      && Array.isArray(r.workspaceIds) && r.workspaceIds.length <= MAX_GRANT_WORKSPACES
      && r.workspaceIds.every((w) => typeof w === 'string' && UUID.test(w))
      && Array.isArray(r.scopes) && r.scopes.length <= 20 && r.scopes.every((x) => typeof x === 'string' && x.length <= 50)
      && (r.userId === undefined || r.userId === null || (typeof r.userId === 'string' && UUID.test(r.userId)));
  }
  return kind === 'system';
}

/** Why a body is not a v1 command, or null. Shallow: the operation validates its own input against the database. */
export function commandProblem(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (b.v !== COMMAND_API_VERSION) return `unsupported version ${JSON.stringify(b.v)}; this endpoint speaks v${COMMAND_API_VERSION}`;
  if (!isKernelOp(b.op)) return `unknown op ${JSON.stringify(b.op)}`;
  if (typeof b.idempotencyKey !== 'string' || !KEY.test(b.idempotencyKey)) return 'idempotencyKey must be 8-200 characters of [A-Za-z0-9:._-]';
  if (!isPrincipal(b.principal)) return 'principal must be { kind: user|account|grant (uuid id) | system, id }';
  const input = b.input as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return 'input must be an object';
  if (b.op === 'drain') return typeof input.deliveryId === 'string' && UUID.test(input.deliveryId) ? null : 'drain needs input.deliveryId (uuid)';
  if (typeof input.workspaceId !== 'string' || !UUID.test(input.workspaceId)) return 'input.workspaceId must be a uuid';
  if ('prNumber' in input && !(Number.isInteger(input.prNumber) && (input.prNumber as number) > 0)) return 'input.prNumber must be a positive integer';
  return null;
}

/** `user:<id>`: how the ledger records the principal (a grant session by its grant, which is what acts). */
export const principalKey = (p: KernelPrincipal): string => (p.kind === 'grant' ? `grant:${p.grantId}` : `${p.kind}:${p.id}`);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export async function requestHash(b: Pick<CommandRequest, 'op' | 'input' | 'principal'>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ op: b.op, input: b.input, principal: b.principal })));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── Keys ────────────────────────────────────────────────────────────────────

// The key ring lives in command-keys.ts (no database code), re-exported here.
export { commandKeyRing, commandsConfigured } from './command-keys';

// ── The endpoint ────────────────────────────────────────────────────────────

/** `EXECUTION_MODE` as the control plane reads it: only an exact `own` hosts. */
export const executionModeOf = (raw: unknown): 'own' | 'shadow' => (raw === 'own' ? 'own' : 'shadow');

export interface CommandServerDeps {
  ledger?: CommandLedger;
  run?: <K extends KernelOp>(op: K, input: KernelOps[K]['input']) => Promise<KernelOps[K]['result']>;
  deliveryAfter?: typeof deliveryAfter;
  /** Whether the principal still reaches the workspace. */
  reaches?: (principal: KernelPrincipal, workspaceId: string | null) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  host?: () => 'control-plane' | 'web';
  newToken?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** How long a second caller waits for the first to finish before answering `in_progress`. */
  waitMs?: number;
  now?: () => number;
}

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...headers } });
const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json({ v: COMMAND_API_VERSION, code, error, ...extra }, status);

/**
 * The session object the web host judged, rebuilt from the principal, so the control plane runs
 * the very same check (`verifyAccountWorkspaceAccess`) on the same inputs: a grant session by
 * its grant, any other account by its row.
 */
export function sessionOfPrincipal(p: Extract<KernelPrincipal, { kind: 'account' | 'grant' }>) {
  if (p.kind === 'grant') return { id: p.id, oauthGrantId: p.grantId, grantScopes: p.scopes, workspaceIds: p.workspaceIds };
  return { id: p.id, oauthGrantId: null };
}

export interface ReachDeps {
  verifyWorkspaceAccess?: (userId: string, workspaceId: string) => Promise<unknown>;
  verifyAccountWorkspaceAccess?: (account: ReturnType<typeof sessionOfPrincipal>, workspaceId: string, permission?: 'canCreate') => Promise<boolean>;
  /** Whether a grant session could be acting as this account: it is its team's shared session account. */
  isSessionAccount?: (accountId: string) => Promise<boolean>;
}

async function defaultIsSessionAccount(accountId: string): Promise<boolean> {
  return (await import('@/lib/oauth/session-account')).isTeamSessionAccount(accountId);
}

/**
 * Default reach check, the web host's rule: a person by team membership; a grant session by its
 * grant; any other API account by its row. A system principal always (buildd's own sweeps). An
 * account principal from a host that predates grant principals (no `grant: null`) is refused
 * when it names a team's shared session account, since that may be a grant session whose grant
 * the request does not carry.
 */
export async function principalReaches(principal: KernelPrincipal, workspaceId: string | null, deps: ReachDeps = {}): Promise<boolean> {
  if (principal.kind === 'system') return true;
  if (!workspaceId) return false;
  const access = deps.verifyWorkspaceAccess && deps.verifyAccountWorkspaceAccess ? null : await import('@/lib/team-access');
  if (principal.kind === 'user') return !!(await (deps.verifyWorkspaceAccess ?? access!.verifyWorkspaceAccess)(principal.id, workspaceId));
  if (principal.kind === 'account' && !('grant' in principal)) {
    if (await (deps.isSessionAccount ?? defaultIsSessionAccount)(principal.id)) return false;
  }
  // Every kernel command is a write, so a grant needs write reach (its `write` scope), exactly as the
  // web host checks a grant session's write. Any other account keeps the read-reach rule its doors
  // apply: a `canCreate` link is not what lets a runner act on its own PR.
  const permission = principal.kind === 'grant' ? 'canCreate' as const : undefined;
  return (deps.verifyAccountWorkspaceAccess ?? access!.verifyAccountWorkspaceAccess)(sessionOfPrincipal(principal), workspaceId, permission);
}

/** `POST /v1/commands`. Never throws: every outcome is a response. */
export async function handleCommandRequest(req: Request, deps: CommandServerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const host = (deps.host ?? kernelHost)();
  if (req.method !== 'POST') return refuse(405, 'method_not_allowed', 'POST only');
  // Only the control plane in own mode applies commands; anything else applies nothing.
  if (host !== 'control-plane' || executionModeOf(env.EXECUTION_MODE) !== 'own') {
    return refuse(409, 'not_host', 'This host does not apply kernel commands in the current mode; the web host runs them.', { mode: executionModeOf(env.EXECUTION_MODE), host });
  }
  const keys = commandKeyRing(env);
  if (Object.keys(keys).length === 0) return refuse(503, 'unconfigured', 'No command key is configured on the control plane.', { retryable: true });

  const url = new URL(req.url);
  const text = await req.text();
  const verdict = await verifyRequest({ keys, method: req.method, path: url.pathname + url.search, body: text, headers: req.headers });
  if (!verdict.ok) return refuse(401, 'unauthorized', `signature ${verdict.why}`);

  let body: unknown;
  try { body = JSON.parse(text); } catch { return refuse(400, 'bad_request', 'body is not JSON'); }
  const problem = commandProblem(body);
  if (problem) return refuse(400, 'bad_request', problem);
  const cmd = body as CommandRequest;
  const workspaceId = cmd.op === 'drain' ? null : String((cmd.input as { workspaceId: string }).workspaceId);
  if (cmd.op === 'drain' && cmd.principal.kind !== 'system') return refuse(403, 'forbidden', 'drain is a system operation');
  if (!(await (deps.reaches ?? principalReaches)(cmd.principal, workspaceId).catch(() => false))) {
    return refuse(403, 'forbidden', `${principalKey(cmd.principal)} does not reach this workspace`);
  }

  const ledger = deps.ledger ?? postgresCommandLedger();
  const hash = await requestHash(cmd);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? 20_000);
  const claim = { key: cmd.idempotencyKey, op: cmd.op, principal: principalKey(cmd.principal), requestHash: hash, host };

  for (;;) {
    const token = (deps.newToken ?? (() => crypto.randomUUID()))();
    if (await ledger.claim({ ...claim, token })) return execute(cmd, token, ledger, deps, host);
    const row = await ledger.read(cmd.idempotencyKey);
    if (row && row.requestHash !== hash) {
      return refuse(422, 'idempotency_key_reused', 'This idempotency key was used for a different request.');
    }
    if (row?.status === 'done' && row.response) {
      const stored = row.response as StoredAnswer;
      return json({ ...stored.body, replayed: true }, stored.status);
    }
    // Running elsewhere (or released after a failure, and the loop claims it): wait for it.
    if (now() >= deadline) {
      return refuse(409, 'in_progress', 'A request with this idempotency key is still running; retry with the same key.', { retryable: true });
    }
    await sleep(200);
  }
}

async function execute(cmd: CommandRequest, token: string, ledger: CommandLedger, deps: CommandServerDeps, host: 'control-plane' | 'web'): Promise<Response> {
  let result: unknown;
  try {
    result = await (deps.run ?? runKernelOp)(cmd.op, cmd.input as never);
  } catch (err) {
    // Nothing is stored: the same key may be tried again. Kernel commands are idempotent on their own keys.
    await ledger.release({ key: cmd.idempotencyKey, token }).catch(() => {});
    console.error(`[kernel-command] ${cmd.op} ${cmd.idempotencyKey} failed:`, err);
    return refuse(500, 'command_failed', err instanceof Error ? err.message : String(err), { retryable: true });
  }
  const delivery = await (deps.deliveryAfter ?? deliveryAfter)(cmd.op, cmd.input, result).catch(() => null);
  const answer: CommandAnswer = { v: COMMAND_API_VERSION, op: cmd.op, idempotencyKey: cmd.idempotencyKey, result: result as never, delivery, host, replayed: false };
  // JSON round trip: the stored answer and this one are byte-identical.
  const body = JSON.parse(JSON.stringify(answer)) as Record<string, unknown>;
  const stored = await ledger.complete({ key: cmd.idempotencyKey, token, response: { status: 200, body }, deliveryId: delivery?.id ?? null, deliveryVersion: delivery?.version ?? null })
    .catch((err) => { console.error(`[kernel-command] storing ${cmd.idempotencyKey} failed:`, err); return false; });
  if (!stored) console.warn(`[kernel-command] ${cmd.idempotencyKey}: the claim was taken over before completion; answering this caller only`);
  return json(body, 200);
}
