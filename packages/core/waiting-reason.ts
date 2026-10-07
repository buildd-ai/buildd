/**
 * Why a pending task is not running: the one `WaitingReason` model
 * (knowledge-base artifact `coordination-visibility-map` §1). The start route,
 * the claim route's force-start bypass and every UI surface read it from here,
 * so the explanation and the behaviour can not drift into two vocabularies.
 *
 * Pure and dependency-free: client components import it too.
 *
 * Only a subset of kinds has a producer today (the coordination probe behind
 * `/api/tasks/[id]/start`). The table carries every kind of the design so a new
 * producer adds rows, never a second model.
 */

export type WaitingClass =
  | 'schedule' | 'hold' | 'dependency' | 'coordination' | 'capacity'
  | 'budget' | 'capability' | 'dispatch' | 'eligible' | 'unknown';

export type WaitingKind =
  | 'start_deferred'
  | 'runner_preference'
  | 'task_held'
  | 'mission_held'
  | 'mission_local'
  | 'dep_declared'
  | 'dep_inferred'
  | 'subject_dead'
  | 'pr_overlap_live'
  | 'pr_overlap_ended'
  | 'lease_overlap'
  | 'lease_stale'
  | 'scope_undeclared_mutex'
  | 'ordered_behind'
  | 'serialized_surface'
  | 'mission_concurrent'
  | 'mission_paced'
  | 'workspace_cap'
  | 'account_slots'
  | 'oauth_parallelism'
  | 'codex_single_flight'
  | 'managed_entitlement'
  | 'mission_budget'
  | 'budget_paused'
  | 'provider_unavailable'
  | 'role_unavailable'
  | 'capability_mismatch'
  | 'runner_cooldown'
  | 'dispatch_undelivered'
  | 'eligible_no_runner'
  | 'unknown';

/** What a force start leaves enforced, shown verbatim in the confirm step. */
export type Rail = 'edit_time_leases' | 'declared_dependencies' | 'budgets_and_seats' | 'runner_capability' | 'task_hold';

export const RAIL_TEXT: Record<Rail, string> = {
  edit_time_leases: 'Files another agent is editing stay locked: this agent waits or is refused on them until they are released.',
  declared_dependencies: 'Declared dependencies still apply.',
  budgets_and_seats: 'Budgets, seats and plan limits still apply.',
  runner_capability: 'It still needs a runner that can run its role and backend.',
  task_hold: 'A hold a person put on the task still applies.',
};

export interface ForceSpec {
  scope: 'member' | 'admin';
  /** Exactly the gate this lifts. */
  lifts: WaitingKind;
  railsRemaining: Rail[];
  mechanism: 'start_context' | 'cap_exempt' | 'clear_start_at';
}

export type BlockerType = 'task' | 'pr' | 'lease' | 'mission' | 'runner' | 'budget' | 'provider' | 'surface' | 'config';

export interface WaitingBlocker {
  type: BlockerType;
  id: string;
  label: string;
  href?: string;
  /** The holder has a live writer. */
  live?: boolean;
}

export type OverlapBasis = 'declared' | 'predicted' | 'observed' | 'pr_scope' | 'lease';

export interface AreaCount { area: string; count: number }

export interface WaitingOverlap {
  areas: AreaCount[];
  pathCount: number;
  /** Drilldown only; capped by the producer. */
  paths?: string[];
  basis: OverlapBasis;
}

export interface WaitingReason {
  kind: WaitingKind;
  class: WaitingClass;
  strength: 'hard' | 'soft';
  intent: 'intentional' | 'incidental';
  blocker?: WaitingBlocker;
  overlap?: WaitingOverlap;
  provenance: {
    source: 'probe' | 'ledger' | 'waiter' | 'planner' | 'task_context' | 'outbox' | 'runner_fleet';
    derivedFrom: string;
    firstSeenAt?: string;
  };
  /** One plain sentence: "both edit packages/core/db/schema.ts". */
  because: string;
  releasesWhen: { event: string; text: string };
  action: { owner: 'human' | 'agent' | 'system'; force: ForceSpec | null };
}

/**
 * The claim loop's deferral key a kind maps to. A force start can only lift a
 * kind that has one: that is the key the claim route checks it against.
 */
export type ClaimLoopKey = 'path_overlap' | 'mission_concurrent' | 'mission_paced' | 'advisory_manifest' | 'ordered_behind';

interface KindSpec {
  class: WaitingClass;
  strength: 'hard' | 'soft';
  intent: 'intentional' | 'incidental';
  /** Plain gate name: the "Skips:" line of the force confirmation. */
  gateName: string;
  releasesWhen: { event: string; text: string };
  owner: 'human' | 'agent' | 'system';
  force: Omit<ForceSpec, 'lifts'> | null;
  claimLoopKey?: ClaimLoopKey;
}

const COORDINATION_RAILS: Rail[] = ['edit_time_leases', 'declared_dependencies', 'budgets_and_seats', 'runner_capability', 'task_hold'];
const POLICY_RAILS: Rail[] = ['edit_time_leases', 'declared_dependencies', 'budgets_and_seats', 'runner_capability', 'task_hold'];
const memberForce = (rails: Rail[] = COORDINATION_RAILS): Omit<ForceSpec, 'lifts'> =>
  ({ scope: 'member', railsRemaining: rails, mechanism: 'start_context' });

/**
 * Classification table (artifact §1.3). `force` is the Stage-2 contract.
 *
 * `scope_undeclared_mutex` (the claim loop's `advisory_manifest`) is NOT
 * forceable here: an admin `claim_task force` does not lift it either, and its
 * relaxation is owned by the Jev HOLD/START work, which decides it with
 * evidence rather than a person's click. Flip `force` here only together
 * with that decision.
 */
export const WAITING_KIND_SPEC: Record<WaitingKind, KindSpec> = {
  start_deferred: { class: 'schedule', strength: 'hard', intent: 'intentional', gateName: 'Scheduled start', releasesWhen: { event: 'time', text: 'its start time passes' }, owner: 'system', force: { scope: 'member', railsRemaining: POLICY_RAILS, mechanism: 'clear_start_at' } },
  runner_preference: { class: 'schedule', strength: 'hard', intent: 'intentional', gateName: 'Runner preference', releasesWhen: { event: 'runner.online', text: 'the preferred runner comes online' }, owner: 'human', force: null },
  task_held: { class: 'hold', strength: 'hard', intent: 'intentional', gateName: 'Task hold', releasesWhen: { event: 'hold.released', text: 'someone releases the hold' }, owner: 'human', force: null },
  mission_held: { class: 'hold', strength: 'hard', intent: 'intentional', gateName: 'Mission hold', releasesWhen: { event: 'mission.armed', text: 'the mission is armed' }, owner: 'human', force: memberForce(POLICY_RAILS) },
  mission_local: { class: 'hold', strength: 'hard', intent: 'intentional', gateName: 'Local-session mission', releasesWhen: { event: 'claimed', text: 'a local session claims it' }, owner: 'human', force: memberForce(POLICY_RAILS) },
  dep_declared: { class: 'dependency', strength: 'hard', intent: 'intentional', gateName: 'Declared dependency', releasesWhen: { event: 'task.completed+merged', text: 'its dependencies complete and merge' }, owner: 'agent', force: memberForce(['edit_time_leases', 'budgets_and_seats', 'runner_capability', 'task_hold']) },
  dep_inferred: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'Inferred file-overlap dependency', releasesWhen: { event: 'task.completed+merged', text: 'the overlapping task completes and merges' }, owner: 'system', force: memberForce() },
  subject_dead: { class: 'dependency', strength: 'hard', intent: 'intentional', gateName: 'Closed subject PR', releasesWhen: { event: 'never', text: 'never: its subject PR is gone' }, owner: 'human', force: memberForce(POLICY_RAILS) },
  pr_overlap_live: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'Open-PR file overlap', releasesWhen: { event: 'path_claim.released', text: 'that PR merges, closes or narrows its files' }, owner: 'agent', force: memberForce(), claimLoopKey: 'path_overlap' },
  pr_overlap_ended: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'Open-PR file overlap', releasesWhen: { event: 'pr.closed', text: 'that PR merges or closes' }, owner: 'system', force: memberForce(), claimLoopKey: 'path_overlap' },
  lease_overlap: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'Files claimed by a running task', releasesWhen: { event: 'path_claim.released', text: 'that task releases or narrows its files' }, owner: 'agent', force: memberForce(), claimLoopKey: 'path_overlap' },
  lease_stale: { class: 'coordination', strength: 'hard', intent: 'incidental', gateName: 'Stale file claim', releasesWhen: { event: 'sweep.hourly', text: 'the hourly sweep releases the stale claim' }, owner: 'system', force: null },
  scope_undeclared_mutex: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'One scope-undeclared task per mission', releasesWhen: { event: 'task.finished', text: 'the other scope-undeclared task finishes or declares its files' }, owner: 'agent', force: null, claimLoopKey: 'advisory_manifest' },
  ordered_behind: { class: 'coordination', strength: 'soft', intent: 'intentional', gateName: 'Planner order', releasesWhen: { event: 'task.claimed', text: 'the task ahead of it is claimed or finishes' }, owner: 'system', force: memberForce(), claimLoopKey: 'ordered_behind' },
  serialized_surface: { class: 'coordination', strength: 'hard', intent: 'intentional', gateName: 'Serialized surface', releasesWhen: { event: 'path_claim.released', text: 'the surface lease is released' }, owner: 'agent', force: null },
  mission_concurrent: { class: 'capacity', strength: 'hard', intent: 'intentional', gateName: 'Mission concurrency limit', releasesWhen: { event: 'slot.freed', text: 'another task in the mission finishes' }, owner: 'system', force: memberForce(), claimLoopKey: 'mission_concurrent' },
  mission_paced: { class: 'capacity', strength: 'hard', intent: 'intentional', gateName: 'Mission pacing', releasesWhen: { event: 'time', text: 'the mission\'s pacing interval passes' }, owner: 'system', force: memberForce(), claimLoopKey: 'mission_paced' },
  workspace_cap: { class: 'capacity', strength: 'hard', intent: 'intentional', gateName: 'Workspace concurrency limit', releasesWhen: { event: 'slot.freed', text: 'a workspace task finishes' }, owner: 'system', force: { scope: 'member', railsRemaining: COORDINATION_RAILS, mechanism: 'cap_exempt' } },
  account_slots: { class: 'capacity', strength: 'hard', intent: 'incidental', gateName: 'Account worker slots', releasesWhen: { event: 'slot.freed', text: 'a worker slot frees' }, owner: 'system', force: null },
  oauth_parallelism: { class: 'capacity', strength: 'hard', intent: 'incidental', gateName: 'Seat parallelism', releasesWhen: { event: 'slot.freed', text: 'seat pressure drops' }, owner: 'system', force: null },
  codex_single_flight: { class: 'capacity', strength: 'hard', intent: 'incidental', gateName: 'One Codex task per workspace', releasesWhen: { event: 'slot.freed', text: 'the running Codex task ends' }, owner: 'system', force: null },
  managed_entitlement: { class: 'budget', strength: 'hard', intent: 'incidental', gateName: 'Plan limit', releasesWhen: { event: 'slot.freed', text: 'a managed run ends or the allowance refills' }, owner: 'system', force: null },
  mission_budget: { class: 'budget', strength: 'hard', intent: 'intentional', gateName: 'Mission budget', releasesWhen: { event: 'budget.raised', text: 'the mission budget is raised' }, owner: 'human', force: memberForce(POLICY_RAILS) },
  budget_paused: { class: 'budget', strength: 'hard', intent: 'incidental', gateName: 'Budget pause', releasesWhen: { event: 'budget.reset', text: 'the budget resets or is raised' }, owner: 'human', force: null },
  provider_unavailable: { class: 'capability', strength: 'hard', intent: 'incidental', gateName: 'Provider unavailable', releasesWhen: { event: 'config.changed', text: 'the provider is re-enabled' }, owner: 'human', force: null },
  role_unavailable: { class: 'capability', strength: 'hard', intent: 'incidental', gateName: 'No runner for this role', releasesWhen: { event: 'runner.online', text: 'a runner with this role comes online' }, owner: 'human', force: null },
  capability_mismatch: { class: 'capability', strength: 'hard', intent: 'incidental', gateName: 'Missing capability', releasesWhen: { event: 'config.changed', text: 'the configuration is fixed' }, owner: 'human', force: null },
  runner_cooldown: { class: 'capability', strength: 'hard', intent: 'incidental', gateName: 'Runner cooldown', releasesWhen: { event: 'time', text: 'the runner cooldown ends' }, owner: 'system', force: null },
  dispatch_undelivered: { class: 'dispatch', strength: 'soft', intent: 'incidental', gateName: 'Wake not delivered', releasesWhen: { event: 'dispatch.delivered', text: 'the wake is delivered' }, owner: 'system', force: null },
  eligible_no_runner: { class: 'eligible', strength: 'soft', intent: 'incidental', gateName: 'No free runner', releasesWhen: { event: 'slot.freed', text: 'a runner frees a slot or comes online' }, owner: 'system', force: null },
  unknown: { class: 'unknown', strength: 'hard', intent: 'incidental', gateName: 'Unknown', releasesWhen: { event: 'unknown', text: 'unknown' }, owner: 'human', force: null },
};

/** Build a reason from the table; producers add blocker, overlap and the sentence. */
export function makeWaitingReason(kind: WaitingKind, fields: {
  because: string;
  blocker?: WaitingBlocker;
  overlap?: WaitingOverlap;
  provenance: WaitingReason['provenance'];
}): WaitingReason {
  const spec = WAITING_KIND_SPEC[kind];
  return {
    kind,
    class: spec.class,
    strength: spec.strength,
    intent: spec.intent,
    ...(fields.blocker ? { blocker: fields.blocker } : {}),
    ...(fields.overlap ? { overlap: fields.overlap } : {}),
    provenance: fields.provenance,
    because: fields.because,
    releasesWhen: spec.releasesWhen,
    action: { owner: spec.owner, force: spec.force ? { ...spec.force, lifts: kind } : null },
  };
}

const rank = (r: WaitingReason): number => {
  if (r.class === 'capability' || r.class === 'unknown') return 0;
  if (r.strength === 'hard' && r.intent === 'intentional') return 1;
  if (r.strength === 'hard') return 2;
  return 3;
};

/** Artifact §1.1 ordering: capability/unknown, hard+intentional, hard+incidental, soft. Stable. */
export function orderWaitingReasons(reasons: readonly WaitingReason[]): WaitingReason[] {
  return reasons.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(x => x.r);
}

/** Reasons that would stop the next claim (soft ones only order it). */
export function blockingReasons(reasons: readonly WaitingReason[]): WaitingReason[] {
  return reasons.filter(r => r.strength === 'hard');
}

/**
 * Force is offered only when every blocking reason is forceable through the
 * start context: one non-forceable reason means the task still would not
 * start, so offering Force would only repeat today's silent "queued".
 */
export function canForceStart(reasons: readonly WaitingReason[]): boolean {
  const hard = blockingReasons(reasons);
  return hard.length > 0 && hard.every(r => r.action.force?.mechanism === 'start_context' && !!WAITING_KIND_SPEC[r.kind].claimLoopKey);
}

/** The claim-loop keys a force start over `kinds` lifts. */
export function claimLoopKeysFor(kinds: readonly WaitingKind[]): ClaimLoopKey[] {
  const out = new Set<ClaimLoopKey>();
  for (const k of kinds) {
    const spec = WAITING_KIND_SPEC[k];
    if (spec?.force && spec.force.mechanism === 'start_context' && spec.claimLoopKey) out.add(spec.claimLoopKey);
  }
  return [...out];
}

/** Rails that stay enforced across every lifted reason (union). */
export function railsRemainingFor(reasons: readonly WaitingReason[]): Rail[] {
  const out = new Set<Rail>();
  for (const r of reasons) for (const rail of r.action.force?.railsRemaining ?? []) out.add(rail);
  return [...out];
}

/**
 * Identity of a reason set, so a confirmation can be refused when what the
 * person saw is no longer what holds the task. Order-insensitive; FNV-1a,
 * because this module must stay dependency-free for the client.
 */
export function waitingReasonsDigest(reasons: readonly WaitingReason[]): string {
  const keys = reasons.map(r => `${r.kind}:${r.blocker?.type ?? ''}:${r.blocker?.id ?? ''}`).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < keys.length; i++) {
    h ^= keys.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Headline status chip (artifact §2). */
export type WaitingChip = 'ready' | 'held' | 'blocked' | 'cant_run' | 'scheduled' | 'unknown';

export function waitingChip(reasons: readonly WaitingReason[]): WaitingChip {
  const head = orderWaitingReasons(reasons)[0];
  if (!head || head.kind === 'eligible_no_runner' || head.class === 'dispatch') return 'ready';
  if (head.kind === 'unknown') return 'unknown';
  if (head.class === 'capability' || head.kind === 'budget_paused' || head.kind === 'account_slots' || head.kind === 'managed_entitlement') return 'cant_run';
  if (head.kind === 'start_deferred') return 'scheduled';
  if (head.kind === 'dep_declared') return 'blocked';
  return 'held';
}

/** "Waiting on PR #3818" — the compact headline a phone shows. */
export function waitingHeadline(r: WaitingReason): string {
  return r.blocker ? `Waiting on ${r.blocker.label}` : `Waiting: ${WAITING_KIND_SPEC[r.kind].gateName.toLowerCase()}`;
}

export function gateName(kind: WaitingKind): string {
  return WAITING_KIND_SPEC[kind].gateName;
}

const CONTAINER_DIRS = new Set(['apps', 'packages', 'services', 'libs']);
const HOT_DIRS = new Set(['db', 'drizzle']);

/**
 * Heuristic code area of a repo-relative path: two levels under a container
 * dir (`apps/web`, written `web`), one more for a schema/migration dir
 * (`core/db`), else the top directory. The configurable classifier of the
 * artifact (§4.3, `gitConfig.codeAreas`) replaces this when it lands.
 */
export function areaOfPath(path: string): string {
  const seg = path.split('/').filter(s => s && s !== '.' && s !== '**');
  if (seg.length <= 1) return seg[0] ?? 'repo';
  if (CONTAINER_DIRS.has(seg[0]) && seg.length > 2) {
    return seg.length > 3 && HOT_DIRS.has(seg[2]) ? `${seg[1]}/${seg[2]}` : seg[1];
  }
  return seg[0];
}

/** Area counts over a path list, most-hit first. */
export function overlapAreas(paths: readonly string[]): AreaCount[] {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(areaOfPath(p), (counts.get(areaOfPath(p)) ?? 0) + 1);
  return [...counts].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

/** Context key of the dashboard force-start intent (see apps/web/src/lib/force-start.ts). */
export const FORCE_START_CONTEXT_KEY = 'forceStart' as const;
export const FORCE_START_HISTORY_KEY = 'forceStartHistory' as const;
/** A force start that no runner claims within this window lapses. */
export const FORCE_START_TTL_MS = 15 * 60 * 1000;

/** The intent `/start` writes and the claim route consumes once. */
export interface ForceStartIntent {
  id: string;
  at: string;
  expiresAt: string;
  userId: string | null;
  accountId: string | null;
  kinds: WaitingKind[];
  /** Claim-loop keys these kinds lift (derived, stored so the claim route reads one field). */
  loopKeys: ClaimLoopKey[];
  reasonsDigest: string;
  /** The blockers at confirmation: the overlap basis evidence for outcome labelling. */
  blockers: Array<{ kind: WaitingKind; type?: BlockerType; id?: string; label?: string; live?: boolean; pathCount?: number; areas?: AreaCount[] }>;
  note?: string | null;
}

/** The intent when it is well-formed and unexpired, else null. */
export function readForceStart(context: Record<string, unknown> | null | undefined, now: Date): ForceStartIntent | null {
  const raw = context?.[FORCE_START_CONTEXT_KEY] as Partial<ForceStartIntent> | undefined;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.loopKeys) || typeof raw.expiresAt !== 'string') return null;
  const exp = Date.parse(raw.expiresAt);
  if (!Number.isFinite(exp) || exp <= now.getTime()) return null;
  return raw as ForceStartIntent;
}
