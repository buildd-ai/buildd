/**
 * Tier model pools — the pure half (docs/design/tier-model-pools.md, P1).
 *
 * A tier is served by a pool of one to four arms. An arm is `(route, model)`.
 * Each tier has two pools, one per surface: agent runs and chat turns. The
 * incumbent arm is the tier's existing registry row; challengers are what an
 * admin adds. In P1 an admin sets every share by hand (`split`) or pins the
 * pool back to its incumbent (`pinned`). There is no bandit here and nothing
 * moves traffic on its own.
 *
 * Everything in this file is a function of its arguments: no db, no clock, no
 * env. The stores half (`./tier-pool-source.ts`) loads rows and writes
 * assignments; this half decides.
 *
 * Invariants:
 *
 * - **The draw only reads the current allocation.** A unit hashes onto [0, 1)
 *   and takes the arm whose cumulative share interval holds that point. The
 *   share in effect is the propensity, recorded with the allocation version.
 * - **Sticky.** A task keeps the arm it drew across re-claims and retries; a
 *   task in a mission takes the mission's arm; a chat turn chain keeps its
 *   arm until the tier changes, the chain goes idle, or the arm stops being
 *   active.
 * - **Guardrails before the draw.** Sensitive workspaces, the premium-plus
 *   tier, explicit models, role pins and reviewer tasks never enter a pool.
 *   Ineligible units write no row.
 * - **Labels and numbers only.** Nothing here takes or returns message text.
 */
import { hashUnitInterval } from './experiment-randomizer';
import { isReviewerTask } from './experiment-lineage';
import type { Tier, TierSurface } from './model-tier-defaults';
import { TIER_SURFACES } from './model-tier-defaults';

export const TIER_POOL_EXPERIMENT_KIND = 'tier_pool' as const;

export type PoolSurface = TierSurface;
export const POOL_SURFACES: readonly PoolSurface[] = TIER_SURFACES;

export type PoolMode = 'pinned' | 'split' | 'explore';

/** Where an arm's calls go and which credential pays for them. */
export type ArmRoute = 'anthropic' | 'openai' | 'openrouter' | 'runner:claude' | 'runner:codex';
/** Agent runs are served by runner credentials. */
export const AGENT_ROUTES: readonly ArmRoute[] = ['runner:claude', 'runner:codex'];
/** Chat turns are served by API keys. */
export const CHAT_ROUTES: readonly ArmRoute[] = ['anthropic', 'openai', 'openrouter'];

export function routesFor(surface: PoolSurface): readonly ArmRoute[] {
  return surface === 'agent' ? AGENT_ROUTES : CHAT_ROUTES;
}

export function isArmRoute(surface: PoolSurface, route: unknown): route is ArmRoute {
  return typeof route === 'string' && (routesFor(surface) as readonly string[]).includes(route);
}

export const MAX_POOL_ARMS = 4;

/**
 * Tiers a pool may exist on. premium-plus is excluded by the owner's rule: it
 * is opt-in, expensive, and kept predictable (design, open question 9).
 */
export function tierAllowsPool(tier: string): tier is Exclude<Tier, 'premium-plus'> {
  return tier === 'premium' || tier === 'standard' || tier === 'budget';
}

/**
 * The incumbent's route on a surface, from the provider of the registry row
 * that surface resolves to (its own row when the tier is split). Agent runs go
 * through runner credentials; chat uses the provider's API key.
 */
export function incumbentRoute(surface: PoolSurface, provider: string): ArmRoute {
  if (surface === 'agent') return provider === 'openai-codex' || provider === 'openai' ? 'runner:codex' : 'runner:claude';
  if (provider === 'openai' || provider === 'openrouter') return provider;
  return 'anthropic';
}

/** The runner backend an agent route runs on. */
export function routeBackend(route: ArmRoute): 'claude' | 'codex' | null {
  if (route === 'runner:claude') return 'claude';
  if (route === 'runner:codex') return 'codex';
  return null;
}

// ── Bounds and allocation ───────────────────────────────────────────────────

export interface PoolBounds {
  /** The incumbent never drops below this share without a promotion. */
  incumbentFloor: number;
  /** Total share of every challenger together. */
  explorationCap: number;
}

export const DEFAULT_POOL_BOUNDS: PoolBounds = { incumbentFloor: 0.6, explorationCap: 0.3 };

/** armId → share. Shares of active arms sum to 1. */
export type Allocation = Record<string, number>;

export interface PoolArmRef {
  id: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused' | 'removed';
}

const EPS = 1e-6;

export type AllocationCheck =
  | { ok: true; allocation: Allocation }
  | { ok: false; error: string };

/**
 * Validate an admin's split before it is written. Shares are fractions, so a
 * typed `20` (meant as 20%) is rejected rather than read as 2000%. Active arms
 * missing from the input read as 0; paused or removed arms may not carry
 * traffic. The result keeps every active arm, rounded to 4 places.
 *
 * `opts.mode === 'split'` skips the floor/cap checks below (see
 * `docs/design/tier-weights.md` §1): a `split` pool's shares come from an
 * admin's own weights via `sharesFromWeights` (`./tier-weights.ts`), and the
 * admin's weights are final — the incumbent may legally go to 0%. Every other
 * mode (the default, and `explore`) keeps the floor and cap enforced, since
 * those bounds are what protect an automatic or bandit-proposed shift.
 */
export function validateAllocation(
  input: unknown,
  arms: readonly PoolArmRef[],
  bounds: PoolBounds = DEFAULT_POOL_BOUNDS,
  opts?: { mode?: PoolMode },
): AllocationCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'allocation must be an object of arm id to share' };
  }
  const active = arms.filter(a => a.status === 'active');
  const incumbent = active.find(a => a.role === 'incumbent');
  if (!incumbent) return { ok: false, error: 'pool has no active incumbent' };
  const activeIds = new Set(active.map(a => a.id));

  const out: Allocation = {};
  for (const a of active) out[a.id] = 0;
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!activeIds.has(id)) return { ok: false, error: `arm ${id} is not an active arm of this pool` };
    const n = typeof raw === 'number' ? raw : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, error: `share for arm ${id} must be a number between 0 and 1` };
    }
    out[id] = Math.round(n * 10_000) / 10_000;
  }

  const total = Object.values(out).reduce((s, v) => s + v, 0);
  if (Math.abs(total - 1) > 1e-3) return { ok: false, error: `shares must sum to 100% (got ${(total * 100).toFixed(1)}%)` };

  if (opts?.mode !== 'split') {
    const challengers = total - out[incumbent.id];
    if (out[incumbent.id] + EPS < bounds.incumbentFloor) {
      return { ok: false, error: `the base model keeps at least ${pct(bounds.incumbentFloor)}` };
    }
    if (challengers > bounds.explorationCap + EPS) {
      return { ok: false, error: `challengers together get at most ${pct(bounds.explorationCap)}` };
    }
  }
  return { ok: true, allocation: out };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** The allocation with every share on the incumbent. */
export function incumbentOnly(arms: readonly PoolArmRef[]): Allocation {
  const out: Allocation = {};
  for (const a of arms) if (a.status === 'active') out[a.id] = a.role === 'incumbent' ? 1 : 0;
  return out;
}

/**
 * Move a removed or paused arm's share onto the incumbent. Used when an arm
 * leaves the pool, so the remaining shares still sum to 1.
 */
export function withoutArm(allocation: Allocation, armId: string, incumbentId: string): Allocation {
  const out: Allocation = { ...allocation };
  const share = out[armId] ?? 0;
  delete out[armId];
  out[incumbentId] = Math.round(((out[incumbentId] ?? 0) + share) * 10_000) / 10_000;
  return out;
}

// ── Draw ────────────────────────────────────────────────────────────────────

export interface PoolDraw {
  armId: string;
  /** The share in effect at the draw. */
  propensity: number;
}

/**
 * Pick the arm whose cumulative interval holds `u`. `armOrder` fixes the
 * interval order (incumbent first, then challengers by when they joined), so
 * a unit keeps its arm when an unrelated share changes further down the list.
 * Arms with no share take no interval; any remainder falls to the first
 * arm. Null when nothing has a share.
 */
export function pickArm(allocation: Allocation, armOrder: readonly string[], u: number): PoolDraw | null {
  let acc = 0;
  let first: PoolDraw | null = null;
  for (const id of armOrder) {
    const share = allocation[id] ?? 0;
    if (!(share > 0)) continue;
    acc += share;
    const draw = { armId: id, propensity: share };
    first ??= draw;
    if (u < acc) return draw;
  }
  // Past the live intervals: rounding left the top a hair under 1, or a share
  // is still on an arm that is no longer live. Either way it falls to the
  // first arm (the incumbent), never onto a challenger past its cap.
  return first;
}

/**
 * Draw an arm for a unit. Salted with `${experimentId}:${policyVersion}:${key}`,
 * the same shape as every other experiment here, so the draw can be replayed
 * offline from those three values and the allocation.
 */
export function drawPoolArm(args: {
  experimentId: string;
  policyVersion: number;
  drawKey: string;
  allocation: Allocation;
  armOrder: readonly string[];
}): PoolDraw | null {
  const u = hashUnitInterval(`${args.experimentId}:${args.policyVersion}:${args.drawKey}`);
  return pickArm(args.allocation, args.armOrder, u);
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export type PoolIneligibleReason =
  | 'tier_excluded'
  | 'sensitive_workspace'
  | 'explicit_model'
  | 'role_model_pinned'
  | 'reviewer_task'
  | 'budget_pressure'
  | 'workspace_override'
  | 'model_routing_experiment'
  | 'pool_not_split';

export interface PoolEligibilityInput {
  tier: string;
  mode: PoolMode;
  frozen: boolean;
  /** `workspaces.dataClass === 'sensitive'`. */
  workspaceSensitive: boolean;
  /**
   * The workspace has its own registry row for this tier, so its incumbent is
   * not the team pool's. P1 pools are team-wide only.
   */
  workspaceOverride: boolean;
  /** Agent only. */
  explicitModel?: string | null;
  roleModel?: string | null;
  category?: string | null;
  reviewerFor?: unknown;
  /** 0..1; agent runs only, checked against `maxBudgetPressure`. */
  budgetPressure?: number;
  maxBudgetPressure?: number;
  /** The unit is already in a model-routing experiment. One experiment per unit. */
  inModelRoutingExperiment?: boolean;
}

/**
 * Is this unit in the pool's population? Ordered so the recorded reason names
 * the most fundamental exclusion.
 */
export function poolEligibility(input: PoolEligibilityInput): { eligible: true } | { eligible: false; reason: PoolIneligibleReason } {
  const no = (reason: PoolIneligibleReason) => ({ eligible: false as const, reason });
  if (!tierAllowsPool(input.tier)) return no('tier_excluded');
  if (!poolTakesDraws(input.mode, input.frozen)) return no('pool_not_split');
  if (input.workspaceSensitive) return no('sensitive_workspace');
  if (input.workspaceOverride) return no('workspace_override');
  if (input.explicitModel) return no('explicit_model');
  if (input.roleModel && input.roleModel !== 'inherit' && !isTierAlias(input.roleModel)) return no('role_model_pinned');
  if (isReviewerTask(input.category, input.reviewerFor)) return no('reviewer_task');
  if (input.inModelRoutingExperiment) return no('model_routing_experiment');
  if (input.budgetPressure != null && input.maxBudgetPressure != null && !(input.budgetPressure < input.maxBudgetPressure)) {
    return no('budget_pressure');
  }
  return { eligible: true };
}

/** Split and explore pools draw; pinned and frozen pools serve the incumbent. */
export function poolTakesDraws(mode: PoolMode, frozen: boolean): boolean {
  return (mode === 'split' || mode === 'explore') && !frozen;
}

/** A role floor names a tier, not a model, so it does not pin one. */
function isTierAlias(m: string): boolean {
  return ['haiku', 'sonnet', 'opus', 'budget', 'standard', 'premium', 'premium-plus'].includes(m);
}

// ── Stickiness ──────────────────────────────────────────────────────────────

/** An existing agent assignment in this pool, reduced to what stickiness needs. */
export interface PriorPoolAssignment {
  taskId: string | null;
  unitType: string;
  unitId: string;
  armId: string | null;
  propensity: number;
  allocationVersion: number | null;
}

export type AgentArmDecision =
  | { source: 'existing' | 'inherited' | 'unit'; armId: string; propensity: number; allocationVersion: number | null }
  | { source: 'drawn'; armId: string; propensity: number; allocationVersion: number }
  | { source: 'none' };

/**
 * An agent unit's arm, in precedence order: the task's own row (a re-claim),
 * its lineage parent's row (a retry or rework), a row for the same unit (the
 * mission's other tasks), else a fresh draw. A reused arm that is no longer
 * active still names the arm; the caller serves the incumbent and records
 * `served = false`.
 */
export function decideAgentArm(args: {
  taskId: string;
  parentId: string | null;
  unitId: string;
  priors: readonly PriorPoolAssignment[];
  activeArmIds: ReadonlySet<string>;
  draw: () => PoolDraw | null;
  allocationVersion: number;
}): AgentArmDecision {
  const pick = (p: PriorPoolAssignment | undefined) => (p && p.armId ? p : undefined);
  const own = pick(args.priors.find(p => p.taskId === args.taskId));
  if (own) return { source: 'existing', armId: own.armId!, propensity: own.propensity, allocationVersion: own.allocationVersion };
  const parent = args.parentId ? pick(args.priors.find(p => p.taskId === args.parentId)) : undefined;
  if (parent) return { source: 'inherited', armId: parent.armId!, propensity: parent.propensity, allocationVersion: parent.allocationVersion };
  // A mission's tasks share its arm while that arm is still active; once it
  // leaves the pool, the mission's next task draws afresh.
  const unit = pick(args.priors.find(p => p.unitId === args.unitId && p.armId && args.activeArmIds.has(p.armId)));
  if (unit) return { source: 'unit', armId: unit.armId!, propensity: unit.propensity, allocationVersion: unit.allocationVersion };
  const d = args.draw();
  if (!d) return { source: 'none' };
  return { source: 'drawn', armId: d.armId, propensity: d.propensity, allocationVersion: args.allocationVersion };
}

/** A chain ends after this long without a turn. */
export const CHAT_CHAIN_IDLE_MS = 6 * 60 * 60 * 1000;

/**
 * Does this turn continue the previous turn's chain? Only when the previous
 * assistant turn ran at the same tier, not long ago, on an arm that is still
 * active. Otherwise the turn draws afresh.
 */
export function continuesChain(args: {
  previous: { tier: string | null; createdAt: Date; armId: string | null } | null;
  tier: string;
  now: Date;
  activeArmIds: ReadonlySet<string>;
}): string | null {
  const p = args.previous;
  if (!p || !p.armId) return null;
  if (p.tier !== args.tier) return null;
  if (args.now.getTime() - p.createdAt.getTime() > CHAT_CHAIN_IDLE_MS) return null;
  if (!args.activeArmIds.has(p.armId)) return null;
  return p.armId;
}

// ── Outcomes and stats ──────────────────────────────────────────────────────

export type Severity = 'none' | 'minor' | 'major' | 'critical';
export const SEVERITIES: readonly Severity[] = ['none', 'minor', 'major', 'critical'];

/** q by severity (design §5a). The gaps are deliberate. */
export const QUALITY_BY_SEVERITY: Record<Severity, number> = { none: 1, minor: 0.75, major: 0.3, critical: 0 };

/** The thumbs-down reasons on a chat turn. Stored as these labels only. */
export const CHAT_FEEDBACK_REASONS = ['wrong_answer', 'wrong_action', 'made_up', 'ignored_me', 'too_slow'] as const;
export type ChatFeedbackReason = typeof CHAT_FEEDBACK_REASONS[number];

export const CHAT_FEEDBACK_REASON_LABELS: Record<ChatFeedbackReason, string> = {
  wrong_answer: 'Wrong answer',
  wrong_action: 'Wrong action',
  made_up: 'Made something up',
  too_slow: 'Too slow',
  ignored_me: 'Ignored what I said',
};

export function isChatFeedbackReason(v: unknown): v is ChatFeedbackReason {
  return typeof v === 'string' && (CHAT_FEEDBACK_REASONS as readonly string[]).includes(v);
}

/**
 * A chat turn's severity from its thumbs. Up is `none`. Down with a reason
 * sets it from the reason; "too slow" is not a mistake. Down with no reason is
 * `minor`: the user said it was bad, not how bad, and P1 has no grader to ask.
 * No thumbs is not graded: silence is not success.
 */
export function chatTurnSeverity(signal: string | null | undefined, reason: string | null | undefined): Severity | null {
  if (signal === 'up') return 'none';
  if (signal !== 'down') return null;
  switch (reason) {
    case 'wrong_answer':
    case 'wrong_action':
    case 'made_up':
      return 'major';
    case 'ignored_me':
      return 'minor';
    case 'too_slow':
      return 'none';
    default:
      return 'minor';
  }
}

/**
 * An agent unit's severity from its terminal outcome. A clean completion is
 * `none`; a model-attributable failure is `major`. An infra failure says
 * nothing about the model, and an unresolved task is not graded yet.
 */
export function agentUnitSeverity(
  outcome: { outcome: string | null | undefined; exitCause?: string | null } | null,
  infraExitCauses: ReadonlySet<string>,
): Severity | null {
  if (!outcome || !outcome.outcome) return null;
  if (outcome.outcome === 'completed') return 'none';
  if (outcome.outcome === 'failed') {
    if (outcome.exitCause && infraExitCauses.has(outcome.exitCause)) return null;
    return 'major';
  }
  return null;
}

export interface ArmUnit {
  severity: Severity | null;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface ArmStats {
  /** Assignments recorded on this arm. */
  units: number;
  /** Units with a severity. */
  graded: number;
  /** Graded units with severity `none`. */
  wins: number;
  winRate: number | null;
  severity: Record<Severity, number>;
  /** Mean q over graded units. */
  meanQuality: number | null;
  /** Mean cost of units that reported one, times 1,000. */
  costPer1k: number | null;
  latencyP50Ms: number | null;
}

/** Graded units an arm needs before its numbers mean much (design §5e). */
export const MIN_GRADED_UNITS: Record<PoolSurface, number> = { agent: 30, chat: 50 };

export function summarizeArm(units: readonly ArmUnit[]): ArmStats {
  const severity: Record<Severity, number> = { none: 0, minor: 0, major: 0, critical: 0 };
  let graded = 0;
  let q = 0;
  const costs: number[] = [];
  const lats: number[] = [];
  for (const u of units) {
    if (u.severity) {
      graded += 1;
      severity[u.severity] += 1;
      q += QUALITY_BY_SEVERITY[u.severity];
    }
    if (u.costUsd != null && Number.isFinite(u.costUsd)) costs.push(u.costUsd);
    if (u.latencyMs != null && Number.isFinite(u.latencyMs)) lats.push(u.latencyMs);
  }
  return {
    units: units.length,
    graded,
    wins: severity.none,
    winRate: graded ? severity.none / graded : null,
    severity,
    meanQuality: graded ? q / graded : null,
    costPer1k: costs.length ? (costs.reduce((s, v) => s + v, 0) / costs.length) * 1000 : null,
    latencyP50Ms: lats.length ? median(lats) : null,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
