// Team-level provider enablement mask + the backend registry the failover
// machinery is driven from.
//
// The per-task backend is resolved through the chain
//   task.backend → mission.defaultBackend → role.defaultBackend → workspace.defaultBackend → 'claude'
// and persisted on the task. The team mask sits ABOVE that chain and is applied
// at dispatch time (claim), so it is fully reversible and never mutates the
// stored per-task/role/workspace settings: disable a provider and matching jobs
// run on an enabled one; re-enable and they snap back to their original backend.

/** Backends that can be persisted on `tasks.backend` (the `agent_backend` enum). */
export type AgentBackend = 'claude' | 'codex';

/**
 * Every backend the registry knows about, including ones that are not runnable
 * yet. Keep this wider than AgentBackend so failover/UI code can reason about a
 * provider before it earns an enum value.
 */
export type BackendId = AgentBackend | 'openrouter';

export interface BackendDescriptor {
  id: BackendId;
  /** Operator-facing name. Single source for every "Paused — X" / button label. */
  label: string;
  /**
   * Secret purposes that make this backend usable for a team/workspace. Any one
   * of them being present counts as configured.
   */
  credentialPurposes: readonly string[];
  /**
   * True when the backend runs on the account's own auth (the claim route
   * already carries it) and so needs no explicit credential row to be usable.
   */
  implicitlyConfigured: boolean;
  /** Lower wins when picking a failover target. */
  failoverPriority: number;
  /**
   * False until BOTH the `agent_backend` DB enum carries the value AND the
   * runner can execute it. Non-dispatchable backends are never selected as a
   * failover target and never written to `tasks.backend`.
   */
  dispatchable: boolean;
}

export const BACKEND_REGISTRY: Record<BackendId, BackendDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    // A team-managed credential is optional: without one, tasks run on the
    // account's own OAuth/API key, which the claim route attaches.
    credentialPurposes: ['claude_credential', 'oauth_token', 'anthropic_api_key'],
    implicitlyConfigured: true,
    failoverPriority: 10,
    dispatchable: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    credentialPurposes: ['codex_credential'],
    implicitlyConfigured: false,
    failoverPriority: 20,
    dispatchable: true,
  },
  // Not runnable per-task yet: the runner can point the Claude CLI at
  // OpenRouter via its llmProvider config (apps/runner/src/index.ts) and the
  // model tier registry accepts provider='openrouter', but no task-level route
  // exists and `agent_backend` has no enum value. Flip `dispatchable` (plus the
  // enum + an `openrouter_credential` purpose) and failover picks it up with no
  // other changes.
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    credentialPurposes: ['openrouter_credential'],
    implicitlyConfigured: false,
    failoverPriority: 30,
    dispatchable: false,
  },
};

/** Registry ids that can actually be dispatched today, in failover order. */
export const DISPATCHABLE_BACKENDS: AgentBackend[] = (Object.values(BACKEND_REGISTRY) as BackendDescriptor[])
  .filter(d => d.dispatchable)
  .sort((a, b) => a.failoverPriority - b.failoverPriority)
  .map(d => d.id as AgentBackend);

/** Operator-facing label for a backend value coming off a task row. */
export function backendLabel(backend: string | null | undefined): string {
  if (!backend) return BACKEND_REGISTRY.claude.label;
  return BACKEND_REGISTRY[backend as BackendId]?.label ?? backend;
}

/** True when `value` is a backend that can be persisted and dispatched. */
export function isDispatchableBackend(value: unknown): value is AgentBackend {
  return typeof value === 'string' && DISPATCHABLE_BACKENDS.includes(value as AgentBackend);
}

/**
 * Mask a resolved backend against the team's enabled-provider list.
 *
 * @param resolved  The backend the resolution chain produced for the task.
 * @param enabled   The team's enabled providers. `null`/`undefined`/`[]` means
 *                  "all enabled" (no mask) — the default for existing teams.
 * @returns The backend to actually run on. If `resolved` is enabled it is
 *          returned unchanged; if disabled, the first enabled provider is used.
 *          If somehow nothing is enabled, `resolved` is returned unchanged
 *          (fail-open — never block all work on a misconfiguration).
 */
export function maskBackend(
  resolved: AgentBackend,
  enabled: AgentBackend[] | null | undefined,
): AgentBackend {
  if (!enabled || enabled.length === 0) return resolved; // no mask
  if (enabled.includes(resolved)) return resolved;        // allowed as-is
  return enabled[0];                                      // disabled → first enabled
}

/**
 * The backend a pending task will actually be dispatched on.
 *
 * The mission → role → workspace chain is resolved and PERSISTED when the task
 * is created (`/api/tasks` POST, `mission-run.ts`), so `tasks.backend` is
 * already the resolved answer — there is no second resolution to redo at read
 * time. What is *not* persisted is the team mask, which the claim route applies
 * per dispatch (`maskBackend`, reversible by design). This function is that one
 * remaining step, so every read-side surface (settings readiness counts, the
 * queue-stall watchdog) lands on the same backend the claim route will pick
 * instead of re-deriving a second, disagreeing order.
 *
 * Not modelled here: the transient provider-pause rewrite the claim route also
 * does (a walled Codex task runs on Claude until the wall lifts). That is a
 * temporary detour — the task returns to its stored backend afterwards — so a
 * caller asking "where does this task permanently land?" wants the un-paused
 * answer.
 */
export function resolveEffectiveBackend(
  taskBackend: string | null | undefined,
  enabled: AgentBackend[] | null | undefined,
): AgentBackend {
  // `tasks.backend` is NOT NULL DEFAULT 'claude'; anything else (a loosely
  // selected column, a non-dispatchable registry id) means "the default".
  const stored: AgentBackend = isDispatchableBackend(taskBackend) ? taskBackend : 'claude';
  return maskBackend(stored, enabled);
}

/** True when the team mask would redirect this backend to a different provider. */
export function isBackendMasked(
  resolved: AgentBackend,
  enabled: AgentBackend[] | null | undefined,
): boolean {
  return maskBackend(resolved, enabled) !== resolved;
}

/** True when the team mask allows this backend to run at all. */
export function isBackendEnabled(
  backend: BackendId,
  enabled: AgentBackend[] | null | undefined,
): boolean {
  if (!BACKEND_REGISTRY[backend]?.dispatchable) return false;
  if (!enabled || enabled.length === 0) return true; // no mask
  return enabled.includes(backend as AgentBackend);
}

/**
 * Backends a job currently on `from` could be moved to, best first.
 *
 * Purely declarative — credential presence, active provider pauses and
 * per-workspace concurrency are layered on by the caller
 * (apps/web/src/lib/backend-failover.ts), which is the only place that can read
 * the DB. Ordering comes from `failoverPriority`, so adding a provider to the
 * registry is enough to make it a candidate everywhere.
 */
export function failoverCandidates(
  from: BackendId | null | undefined,
  enabled: AgentBackend[] | null | undefined,
): AgentBackend[] {
  const current = from ?? 'claude';
  return DISPATCHABLE_BACKENDS.filter(id => id !== current && isBackendEnabled(id, enabled));
}

/** Runtime availability of one backend, as observed by the caller. */
export interface BackendAvailability {
  backend: AgentBackend;
  /** Credentials present (or none needed). */
  configured: boolean;
  /** Active budget/rate-limit or auth pause; null when the pool is open. */
  pausedUntil?: Date | null;
  /** Provider-level concurrency already taken (e.g. Codex allows 1 per workspace). */
  busy?: boolean;
}

export type FailoverBlockReason = 'masked' | 'not_configured' | 'paused' | 'busy';

export interface FailoverDecision {
  /** The backend to move to, or null when nothing is usable. */
  backend: AgentBackend | null;
  /** Why each rejected candidate was skipped — surfaced in logs and the UI. */
  blocked: Array<{ backend: AgentBackend; reason: FailoverBlockReason; pausedUntil?: Date | null }>;
}

/**
 * Pick the backend a stuck job should move to.
 *
 * Pure: the caller supplies observed availability, so this is the one place the
 * precedence rules live (registry order → team mask → credentials → active
 * pause → provider concurrency) and both the claim route and the worker-report
 * route reach the same answer. A candidate with no availability entry is
 * treated as unknown and skipped rather than optimistically dispatched.
 */
export function pickFailoverBackend(opts: {
  from: BackendId | null | undefined;
  enabledBackends?: AgentBackend[] | null;
  availability: BackendAvailability[];
  now?: Date;
}): FailoverDecision {
  const now = opts.now ?? new Date();
  const byId = new Map(opts.availability.map(a => [a.backend, a]));
  const blocked: FailoverDecision['blocked'] = [];

  for (const candidate of failoverCandidates(opts.from, opts.enabledBackends)) {
    const seen = byId.get(candidate);
    if (!seen || !seen.configured) {
      blocked.push({ backend: candidate, reason: 'not_configured' });
      continue;
    }
    if (seen.pausedUntil && seen.pausedUntil > now) {
      blocked.push({ backend: candidate, reason: 'paused', pausedUntil: seen.pausedUntil });
      continue;
    }
    if (seen.busy) {
      blocked.push({ backend: candidate, reason: 'busy' });
      continue;
    }
    return { backend: candidate, blocked };
  }

  // Anything the mask removed is reported too, so "why didn't it fail over?"
  // has an answer even when the provider is disabled team-wide.
  for (const id of DISPATCHABLE_BACKENDS) {
    if (id === (opts.from ?? 'claude')) continue;
    if (!isBackendEnabled(id, opts.enabledBackends)) blocked.push({ backend: id, reason: 'masked' });
  }

  return { backend: null, blocked };
}

// ── Pinned backends ──────────────────────────────────────────────────────────

/**
 * `tasks.context` marker: the task's creator (or an operator, via update_task)
 * asked for this backend explicitly. `tasks.backend` is NOT NULL with a
 * 'claude' default, so the column alone cannot tell "asked for Claude" apart
 * from "nobody said". Failover (claim-time or worker-report, either direction)
 * never moves a pinned task; it waits for its own provider instead. The team
 * provider mask still applies: a disabled provider runs nothing.
 */
export const BACKEND_PINNED_KEY = 'backendPinned' as const;

export function isBackendPinned(context: unknown): boolean {
  return !!context && typeof context === 'object'
    && (context as Record<string, unknown>)[BACKEND_PINNED_KEY] === true;
}

// ── Why a task runs on the backend it runs on ────────────────────────────────

/**
 * `tasks.context` key the claim route stamps when THIS claim ran the task on a
 * backend other than the one stored on it (the flip is in-memory: the row
 * keeps its own backend). Rewritten on every claim, and absent when the claim
 * ran the stored backend, so it always describes the latest attempt.
 */
export const BACKEND_ROUTING_KEY = 'backendRouting' as const;

export type ClaimRoutingReason =
  /** Claude's OAuth seat (account session, tenant budget or a recorded Claude pause) is walled. */
  | 'claude_seat_exhausted'
  /** Claude is disabled by the team's provider mask. */
  | 'claude_disabled'
  /** Codex is disabled by the team's provider mask. */
  | 'codex_disabled'
  /** Codex has an active rate-limit/budget pause. */
  | 'codex_rate_limited';

export interface ClaimBackendRouting {
  backend: AgentBackend;
  from: AgentBackend;
  reason: ClaimRoutingReason;
  at?: string;
}

export interface BackendRoutingDescription {
  backend: AgentBackend;
  from: AgentBackend;
  reason: string;
  /** `claim` = this attempt's in-memory flip; `worker_report` = a persisted move after a failed run. */
  source: 'claim' | 'worker_report';
  summary: string;
}

const CLAIM_ROUTING_SUMMARY: Record<ClaimRoutingReason, (to: string) => string> = {
  claude_seat_exhausted: (to) => `routed to ${to} by budget failover (Claude seat exhausted)`,
  claude_disabled: (to) => `routed to ${to} because Claude is disabled for the team`,
  codex_disabled: (to) => `routed to ${to} because Codex is disabled for the team`,
  codex_rate_limited: (to) => `routed to ${to} by budget failover (Codex rate-limited)`,
};

/**
 * One sentence for "why is this task on this backend?", for explain, get_task
 * and the task summary. Reads the claim stamp first (it is the newer fact),
 * then the worker-report failover stamp (`failedOverFrom` / `failoverReason`).
 * Null when nothing moved the task.
 */
export function describeBackendRouting(
  context: unknown,
  storedBackend?: string | null,
): BackendRoutingDescription | null {
  if (!context || typeof context !== 'object') return null;
  const ctx = context as Record<string, unknown>;
  const stamp = ctx[BACKEND_ROUTING_KEY] as Partial<ClaimBackendRouting> | undefined;
  if (
    stamp && typeof stamp === 'object'
    && isDispatchableBackend(stamp.backend) && isDispatchableBackend(stamp.from)
    && typeof stamp.reason === 'string' && Object.hasOwn(CLAIM_ROUTING_SUMMARY, stamp.reason)
  ) {
    const reason = stamp.reason as ClaimRoutingReason;
    return {
      backend: stamp.backend,
      from: stamp.from,
      reason,
      source: 'claim',
      summary: CLAIM_ROUTING_SUMMARY[reason](backendLabel(stamp.backend)),
    };
  }
  const from = ctx.failedOverFrom;
  if (isDispatchableBackend(from)) {
    const backend: AgentBackend = isDispatchableBackend(storedBackend)
      ? storedBackend
      : (from === 'claude' ? 'codex' : 'claude');
    const reason = typeof ctx.failoverReason === 'string' ? ctx.failoverReason : 'unknown';
    const why = reason === 'auth_failure'
      ? `${backendLabel(from)} rejected its credential`
      : reason === 'budget_exhausted'
        ? `${backendLabel(from)} hit a budget wall`
        : `${backendLabel(from)} failed (${reason})`;
    return { backend, from, reason, source: 'worker_report', summary: `moved to ${backendLabel(backend)} by failover after ${why}` };
  }
  return null;
}
