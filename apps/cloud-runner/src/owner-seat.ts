/**
 * The owner seat: the deployer's own `claude setup-token` value, set as a
 * Worker secret on THEIR Cloudflare account and used for the model calls of
 * the workspaces this Worker serves. The self-hosted equivalent of a CI secret.
 *
 * Boundaries (README "Running on your own Claude token"):
 * - The token exists only as the Worker secret `CLAUDE_CODE_OAUTH_TOKEN`.
 *   buildd's server never receives, stores, logs or returns it, and the
 *   container never sees it: the egress handler injects it after stripping
 *   whatever auth the container supplied (outbound.ts, route kind `owner_seat`).
 * - One Worker, one seat owner. No pooling, no per-member token map.
 * - Off unless the secret is present; hosted/managed runners never enable it.
 * - A per-Worker cap on concurrent seat runs, and a usage wall that pauses new
 *   seat runs (they wait, deferred with a reason) instead of failing them.
 *
 * Everything here is pure: the WorkerAgent keeps the gate state in storage.
 */

/** The Worker secret. Never copied into the container env, a report, a log or a claim. */
export const OWNER_SEAT_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Durable Object name of the per-Worker gate (a WorkerAgent instance that never runs a task). */
export const OWNER_SEAT_GATE_NAME = '__owner_seat_gate__';

export const DEFAULT_SEAT_CAP = 2;
export const MAX_SEAT_CAP = 20;

/** Claim-deferral reasons recorded on the run state and the run report. */
export const SEAT_CAP_REASON = 'owner_seat_cap';
export const SEAT_WALL_REASON = 'owner_seat_wall';

/** A holder that never released (agent evicted mid-run) stops counting after this. */
export const SEAT_HOLD_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a full cap suggests waiting. */
export const SEAT_CAP_RETRY_MS = 60 * 1000;
/** A wall with no reset time in the response. */
export const SEAT_WALL_DEFAULT_MS = 30 * 60 * 1000;
export const SEAT_WALL_MIN_MS = 60 * 1000;
export const SEAT_WALL_MAX_MS = 6 * 60 * 60 * 1000;

/** The Anthropic beta flag an OAuth bearer token needs on the model API. */
export const OAUTH_BETA = 'oauth-2025-04-20';

export interface OwnerSeatEnv {
  /** Secret. See OWNER_SEAT_SECRET. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Var. Concurrent seat runs per Worker; default 2, 1 to 20. */
  OWNER_SEAT_MAX_CONCURRENT?: string;
  /** Var. `1` on a hosted/managed runner: the seat is refused even if a secret is present. */
  MANAGED_CLOUD_RUNNER?: string;
}

/** The token, or null when the seat is off (absent, blank, or a managed runner). */
export function ownerSeatToken(env: OwnerSeatEnv): string | null {
  if (env.MANAGED_CLOUD_RUNNER === '1') return null;
  const t = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : null;
}

export function ownerSeatEnabled(env: OwnerSeatEnv): boolean {
  return ownerSeatToken(env) !== null;
}

export function ownerSeatCap(env: OwnerSeatEnv): number {
  const raw = env.OWNER_SEAT_MAX_CONCURRENT?.trim() ?? '';
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SEAT_CAP) : DEFAULT_SEAT_CAP;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export interface SeatGateState {
  /** taskId → when its hold lapses if never released. */
  holders: Record<string, number>;
  /** Epoch ms until which no new seat run starts; null when there is no wall. */
  wallUntil: number | null;
}

export const EMPTY_SEAT_GATE: SeatGateState = { holders: {}, wallUntil: null };

export type SeatAcquire =
  | { granted: true }
  | { granted: false; reason: typeof SEAT_CAP_REASON | typeof SEAT_WALL_REASON; retryAfterMs: number };

function live(state: SeatGateState, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, until] of Object.entries(state.holders)) if (until > now) out[id] = until;
  return out;
}

/** Take a slot for `taskId`. Idempotent for a task that already holds one. */
export function acquireSeat(state: SeatGateState, taskId: string, now: number, cap: number): { state: SeatGateState; result: SeatAcquire } {
  const holders = live(state, now);
  const wallUntil = state.wallUntil !== null && state.wallUntil > now ? state.wallUntil : null;
  if (taskId in holders) {
    return { state: { holders: { ...holders, [taskId]: now + SEAT_HOLD_TTL_MS }, wallUntil }, result: { granted: true } };
  }
  if (wallUntil !== null) {
    return { state: { holders, wallUntil }, result: { granted: false, reason: SEAT_WALL_REASON, retryAfterMs: wallUntil - now } };
  }
  if (Object.keys(holders).length >= cap) {
    return { state: { holders, wallUntil }, result: { granted: false, reason: SEAT_CAP_REASON, retryAfterMs: SEAT_CAP_RETRY_MS } };
  }
  return { state: { holders: { ...holders, [taskId]: now + SEAT_HOLD_TTL_MS }, wallUntil }, result: { granted: true } };
}

export function releaseSeat(state: SeatGateState, taskId: string, now: number): SeatGateState {
  const holders = live(state, now);
  delete holders[taskId];
  return { holders, wallUntil: state.wallUntil !== null && state.wallUntil > now ? state.wallUntil : null };
}

/** Record a usage wall until `untilMs`. A shorter report never shortens an existing wall. */
export function markSeatWall(state: SeatGateState, untilMs: number, now: number): SeatGateState {
  const clamped = Math.min(Math.max(untilMs, now + SEAT_WALL_MIN_MS), now + SEAT_WALL_MAX_MS);
  const current = state.wallUntil !== null && state.wallUntil > now ? state.wallUntil : 0;
  return { holders: live(state, now), wallUntil: Math.max(current, clamped) };
}

/**
 * When a 429 from the seat route says the wall lifts: `retry-after` (seconds
 * or an HTTP date), else Anthropic's unified reset (epoch seconds or an ISO
 * date), else a default. Only header values; never a body.
 */
export function wallUntilFromHeaders(headers: { get(name: string): string | null }, now: number): number {
  const retry = headers.get('retry-after')?.trim();
  if (retry) {
    if (/^\d{1,9}$/.test(retry)) return now + Number(retry) * 1000;
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return at;
  }
  const reset = headers.get('anthropic-ratelimit-unified-reset')?.trim();
  if (reset) {
    if (/^\d{9,10}$/.test(reset)) return Number(reset) * 1000;
    const at = Date.parse(reset);
    if (Number.isFinite(at)) return at;
  }
  return now + SEAT_WALL_DEFAULT_MS;
}

/** `anthropic-beta` with the OAuth flag added once. */
export function withOauthBeta(existing: string | null): string {
  const parts = (existing ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(',');
}

/** Backoff for a run deferred by the gate: longer than a capacity retry, since a wall lasts. */
export const SEAT_RETRY_BACKOFF_S = [60, 120, 300, 600, 900, 1800, 1800, 1800] as const;

export type ModelAuth = 'owner_seat' | 'metered';

// ── One run's view of the gate ────────────────────────────────────────────────

/** The per-Worker gate, as the WorkerAgent reaches it (an RPC to the gate agent). */
export interface SeatGatePort {
  acquire(taskId: string): Promise<SeatAcquire>;
  release(taskId: string): Promise<void>;
  wall(untilMs: number): Promise<void>;
}

export type SeatRouteDecision =
  | { proceed: true }
  | { proceed: false; reason: typeof SEAT_CAP_REASON | typeof SEAT_WALL_REASON; retryAfterMs: number };

/**
 * Holds one task's slot and what kind of credential its model calls used.
 * The slot is taken before the run starts (the supervisor), because only then
 * can a full cap or a wall defer the task cleanly. The route is only known at
 * the first model call (a team endpoint or Anthropic key may win over the
 * seat), so a run that turns out metered gives its slot straight back.
 */
export class OwnerSeatRun {
  private held = false;
  private auth: ModelAuth | null = null;

  constructor(private readonly d: {
    taskId: string;
    gate: SeatGatePort;
    now(): number;
    log?(message: string): void;
  }) {}

  modelAuth(): ModelAuth | null {
    return this.auth;
  }

  async acquire(): Promise<SeatAcquire> {
    this.auth = null;
    const r = await this.d.gate.acquire(this.d.taskId);
    this.held = r.granted;
    return r;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await this.d.gate.release(this.d.taskId);
  }

  /**
   * A model request is about to go out on the seat route (`seat`) or on a
   * metered one. A seat request without a slot (the agent restarted mid-run)
   * asks for one now and is told to wait when there is none.
   */
  async noteRoute(seat: boolean): Promise<SeatRouteDecision> {
    if (!seat) {
      this.auth = 'metered';
      await this.release();
      return { proceed: true };
    }
    if (!this.held) {
      const r = await this.d.gate.acquire(this.d.taskId);
      if (!r.granted) return { proceed: false, reason: r.reason, retryAfterMs: r.retryAfterMs };
      this.held = true;
    }
    this.auth = 'owner_seat';
    return { proceed: true };
  }

  /** The seat route answered 429: nothing new starts on this seat until the wall lifts. */
  async noteWall(headers: { retryAfter: string | null; reset: string | null }): Promise<void> {
    const get = (n: string) => (n === 'retry-after' ? headers.retryAfter : n === 'anthropic-ratelimit-unified-reset' ? headers.reset : null);
    const until = wallUntilFromHeaders({ get }, this.d.now());
    this.d.log?.(`[cloud-runner] task ${this.d.taskId}: owner seat hit its usage limit; new seat runs wait ${Math.round(Math.max(0, until - this.d.now()) / 1000)}s`);
    await this.d.gate.wall(until);
  }
}
