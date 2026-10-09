/**
 * The one delivery projection every surface reads: where a task or a mission
 * stands on Build → Audit → Land, how many repair rounds it took, and whether
 * anything genuinely waits on a person. Pure.
 *
 * Contract: knowledge-base `cross-surface-delivery-spec` (v2), approved in the
 * `cross-surface-delivery-design-review`. Prototype:
 * docs/prototypes/cross-surface-delivery/.
 *
 * Four facts this module keeps apart, because the UI used to fold them into
 * one "done":
 *   agent done  — the worker stopped (`agentDone`)
 *   landed      — the PR merged into its intended branch (`landed`)
 *   complete    — the mission was closed (`milestones.complete`)
 *   released    — a release carried it to production (`milestones.released`)
 *
 * The workflow kernel (docs/specs/workflow-state-kernel.md) is a draft spec,
 * not code. Until it ships, `projectTaskDelivery` computes the same vocabulary
 * from today's worker/PR fields. When the kernel lands, `projectKernelState` is
 * the single seam to swap in; nothing downstream changes.
 */
import type { computeMissionProgress, deriveTaskType, isAttempt } from '@buildd/core/mission-helpers';
import { prShipState } from '@buildd/core/pr-shipped';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** A delivery's chip. One vocabulary on Home, Activity, Missions and detail. */
export type DeliveryKind =
  | 'landed' | 'landing' | 'audit' | 'repair' | 'build'
  | 'waiting' | 'held' | 'planning'
  | 'unavailable' | 'notlanded' | 'needs';

/**
 * What the platform is doing about it, in the words the count contracts use.
 * Every kind maps to exactly one status (`STATUS_OF`).
 */
export type DeliveryStatus =
  | 'executing' | 'awaiting_audit' | 'awaiting_merge' | 'repair' | 'waiting'
  | 'needs_human' | 'audit_unavailable' | 'not_landed' | 'landed';

export type DeliveryTone = 'success' | 'info' | 'warning' | 'ink' | 'muted' | 'error';

/** Glyph + word for every kind: never colour alone. */
export const DELIVERY_KIND: Record<DeliveryKind, { label: string; glyph: string; tone: DeliveryTone }> = {
  landed: { label: 'Landed', glyph: '■', tone: 'success' },
  landing: { label: 'Landing', glyph: '▲', tone: 'success' },
  audit: { label: 'In audit', glyph: '◐', tone: 'info' },
  repair: { label: 'Repairing', glyph: '↻', tone: 'warning' },
  build: { label: 'Building', glyph: '▶', tone: 'ink' },
  waiting: { label: 'Waiting', glyph: '◇', tone: 'muted' },
  held: { label: 'Held', glyph: '‖', tone: 'muted' },
  planning: { label: 'Planning', glyph: '○', tone: 'muted' },
  unavailable: { label: 'Audit can’t run', glyph: '⊘', tone: 'warning' },
  notlanded: { label: 'Not landed', glyph: '✕', tone: 'error' },
  needs: { label: 'Needs input', glyph: '!', tone: 'ink' },
};

const STATUS_OF: Record<DeliveryKind, DeliveryStatus> = {
  landed: 'landed', landing: 'awaiting_merge', audit: 'awaiting_audit', repair: 'repair', build: 'executing',
  waiting: 'waiting', held: 'waiting', planning: 'waiting',
  unavailable: 'audit_unavailable', notlanded: 'not_landed', needs: 'needs_human',
};

export const DELIVERY_STAGES = ['Build', 'Audit', 'Land'] as const;

/**
 * Position on the Build › Audit › Land track: 0..2 is the current stage, 3 is
 * past Land, -1 is not on the track yet (waiting, held, planning). Repair is
 * Audit with a round count, never a fourth stage.
 */
export function deliveryStageIndex(kind: DeliveryKind): number {
  switch (kind) {
    case 'build': return 0;
    case 'audit': case 'repair': case 'unavailable': case 'needs': return 1;
    case 'landing': case 'notlanded': return 2;
    case 'landed': return 3;
    default: return -1;
  }
}

/** `↻N`: the repair count, defined once for every surface. Empty at zero. */
export function repairBadge(rounds: number): string {
  return rounds > 0 ? `↻${rounds}` : '';
}

// ── Kernel seam ─────────────────────────────────────────────────────────────

/** `workflow_deliveries.state` (workflow-state-kernel §4). */
export type KernelDeliveryState =
  | 'WORKING' | 'AWAITING_PUSH' | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'FIXING' | 'REPAIRING'
  | 'BLOCKED_ON_TRUNK' | 'APPROVED' | 'LANDING' | 'ESCALATED' | 'MERGED' | 'CLOSED_UNMERGED'
  | 'SUPERSEDED' | 'ABANDONED' | 'FAILED';

/** The spec's projection table. ESCALATED is the only route to a person. */
export function projectKernelState(state: KernelDeliveryState): DeliveryKind {
  switch (state) {
    case 'WORKING': case 'AWAITING_PUSH': return 'build';
    case 'AWAITING_REVIEW': case 'APPROVED': case 'BLOCKED_ON_TRUNK': return 'audit';
    case 'CHANGES_REQUESTED': case 'FIXING': case 'REPAIRING': return 'repair';
    case 'LANDING': return 'landing';
    case 'MERGED': case 'SUPERSEDED': return 'landed';
    case 'ESCALATED': return 'needs';
    case 'CLOSED_UNMERGED': case 'ABANDONED': case 'FAILED': return 'notlanded';
  }
}

// ── Head-bound verdicts ─────────────────────────────────────────────────────

export interface ReviewEvidence {
  verdict: 'approve' | 'request-changes' | 'escalate' | null;
  /** `PrReviewStatus.state`, when known. */
  state?: string | null;
  /** The commit the verdict judged (`reviewHeadSha`). */
  headSha: string | null;
  /** Later heads an approval was carried to (approval-carry-forward.ts). */
  equivalentHeadShas?: readonly string[];
}

/**
 * passed / changes_requested: a verdict on the current head.
 * stale: a verdict on an older head — recorded, never counted.
 * unbound: a verdict whose head, or the PR's current head, is unknown; it
 *   cannot be shown as passed either, because nothing ties it to this code.
 */
export type BoundVerdict = 'passed' | 'changes_requested' | 'escalated' | 'stale' | 'unbound' | 'pending' | 'unavailable' | 'none';

const sameSha = (a: string, b: string) => {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  // Prefix match only past git's shortest abbreviation, so `abc` never matches.
  return x === y || (x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x)));
};

export function bindVerdict(review: ReviewEvidence | null | undefined, currentHeadSha: string | null | undefined): BoundVerdict {
  if (!review) return 'none';
  if (review.verdict === 'escalate' || review.state === 'escalated') return 'escalated';
  if (review.state === 'review_failed') return 'unavailable';
  if (!review.verdict) return review.state === 'queued' || review.state === 'reviewing' ? 'pending' : 'none';
  if (!review.headSha || !currentHeadSha) return 'unbound';
  const bound = sameSha(review.headSha, currentHeadSha) || (review.equivalentHeadShas ?? []).some(s => sameSha(s, currentHeadSha));
  if (!bound) return 'stale';
  return review.verdict === 'approve' ? 'passed' : 'changes_requested';
}

// ── Task projection ─────────────────────────────────────────────────────────

const LIVE: ReadonlySet<string> = new Set(LIVE_WORKER_STATUSES);

export interface DeliveryWorker {
  status: string;
  prUrl?: string | null;
  mergedAt?: string | Date | null;
  prLifecycleStatus?: string | null;
  supersededByPrNumber?: number | null;
  abandonedAt?: string | Date | null;
}

export interface TaskDeliveryInput {
  /** `tasks.status`. */
  status: string;
  /** The task's workers, attempts' workers included. */
  workers: readonly DeliveryWorker[];
  /** Repair attempts taken (CI, conflict and review-fix retries). */
  repairRounds?: number;
  review?: ReviewEvidence | null;
  /** The PR's current head, when known. */
  headSha?: string | null;
  /** Why an unclaimed task has not started. Defaults to capacity. */
  waitingOn?: 'dependency' | 'capacity';
}

export interface TaskDelivery {
  kind: DeliveryKind;
  status: DeliveryStatus;
  /** Not landed, and not settled as dropped. */
  open: boolean;
  /** No agent is live on it and it has stopped (completed or failed). */
  agentDone: boolean;
  landed: boolean;
  repairRounds: number;
  verdict: BoundVerdict;
  /** Only a question or an escalation. Auto-recovery never is. */
  needsHuman: boolean;
  waitingOn: 'dependency' | 'capacity' | null;
  /** What repair is for, when the kind is repair. */
  repairReason: 'ci' | 'conflict' | 'review' | null;
  /**
   * Not landed because its PR closed unmerged, and the platform is still
   * checking whether another PR carries the work. Abandoned PRs and failed or
   * cancelled tasks are never reconciling: those are for a person.
   */
  reconciling: boolean;
}

/** The PR a task's delivery is about: a merged one wins, else the newest with a URL. */
function deliveryPr(workers: readonly DeliveryWorker[]): DeliveryWorker | undefined {
  return workers.find(w => w.prUrl && (w.mergedAt || w.supersededByPrNumber)) ?? workers.find(w => w.prUrl);
}

export function projectTaskDelivery(input: TaskDeliveryInput): TaskDelivery {
  const repairRounds = input.repairRounds ?? 0;
  const live = input.workers.filter(w => LIVE.has(w.status));
  const pr = deliveryPr(input.workers);
  const ship = prShipState(pr);
  const verdict = bindVerdict(input.review, input.headSha);
  const agentDone = live.length === 0 && (input.status === 'completed' || input.status === 'failed');
  const make = (kind: DeliveryKind, extra: Partial<TaskDelivery> = {}): TaskDelivery => ({
    kind,
    status: STATUS_OF[kind],
    open: kind !== 'landed' && !(kind === 'notlanded' && (ship === 'abandoned' || input.status === 'cancelled')),
    agentDone,
    landed: kind === 'landed',
    repairRounds,
    verdict,
    needsHuman: kind === 'needs',
    waitingOn: null,
    repairReason: null,
    reconciling: false,
    ...extra,
  });

  if (ship === 'merged' || ship === 'superseded') return make('landed');
  if (live.some(w => w.status === 'waiting_input') || verdict === 'escalated') return make('needs');
  if (ship === 'closed_unsuperseded') return make('notlanded', { reconciling: true });
  if (ship === 'abandoned') return make('notlanded');

  if (ship === 'open') {
    const ci = pr?.prLifecycleStatus;
    // A live agent on an open PR after a repair was dispatched is the repair.
    if (live.length > 0) return repairRounds > 0 ? make('repair', { repairReason: ci === 'conflict' ? 'conflict' : ci === 'ci_failed' ? 'ci' : 'review' }) : make('build');
    if (ci === 'ci_failed') return make('repair', { repairReason: 'ci' });
    if (ci === 'conflict') return make('repair', { repairReason: 'conflict' });
    if (verdict === 'changes_requested') return make('repair', { repairReason: 'review' });
    if (verdict === 'unavailable' || ci === 'unresolvable') return make('unavailable');
    // Landing needs both: an approval on THIS head and green CI on it.
    if (verdict === 'passed' && ci === 'ci_green') return make('landing');
    return make('audit');
  }

  // No PR.
  if (live.length > 0) return make('build');
  if (input.status === 'completed') return make('landed');
  if (input.status === 'failed' || input.status === 'cancelled') return make('notlanded');
  return make('waiting', { waitingOn: input.waitingOn ?? 'capacity' });
}

// ── Mission projection ──────────────────────────────────────────────────────

/** A mission task row as Home and the missions list load it (MISSION_CARD_TASK_COLUMNS). */
export interface MissionTaskRow {
  id: string;
  title: string;
  status: string;
  taskClass?: string | null;
  kind?: string | null;
  mode?: string | null;
  creationSource?: string | null;
  category?: string | null;
  parentTaskId?: string | null;
  dependsOn?: readonly string[] | null;
  workers?: readonly DeliveryWorker[] | null;
}

export interface MissionDeliveryInput {
  id: string;
  title: string;
  /** `missions.status`. */
  status: string;
  href: string;
  isHeld?: boolean;
  /** Mission-branch strategy: task PRs land on the integration branch, trunk is later. */
  integrationBranch?: boolean;
  /** Whether a release carried the mission; null/absent when unknown. */
  released?: boolean | null;
  tasks: readonly MissionTaskRow[];
  /** Per-task review evidence, when the caller has it. */
  reviews?: ReadonlyMap<string, { review: ReviewEvidence; headSha: string | null }>;
}

export interface MissionMilestones {
  /** No agent is live on any task and every task stopped. */
  agentsDone: boolean;
  /** Every deliverable landed on its intended branch. */
  allLanded: boolean;
  /** Mission-branch only: false until the mission reaches trunk; null without one. */
  onTrunk: boolean | null;
  complete: boolean;
  released: boolean | null;
}

export interface MissionDelivery {
  id: string;
  title: string;
  href: string;
  kind: DeliveryKind;
  open: boolean;
  /** Same numerator/denominator as `computeMissionProgress` on every surface. */
  landed: number;
  total: number;
  /** Deliverables past Build and not landed (in audit, repairing or landing). */
  inAudit: number;
  /** At least one live agent on the mission. */
  executing: boolean;
  repairRounds: number;
  milestones: MissionMilestones;
  /** The task the chip is about. */
  focus: { id: string; title: string } | null;
  evidence: string;
  next: string;
  exception: { tone: DeliveryTone; text: string } | null;
  /** The chip is a closed PR the platform is still reconciling (see `TaskDelivery.reconciling`). */
  reconciling?: boolean;
  tasks: Array<{ id: string; title: string; delivery: TaskDelivery }>;
}

/** Most attention-worthy first: the mission's chip is its worst open task. */
const MISSION_PRIORITY: readonly DeliveryKind[] = ['needs', 'notlanded', 'unavailable', 'repair', 'audit', 'landing', 'build', 'waiting', 'held', 'planning', 'landed'];
const OPEN_MISSION_STATUSES = new Set(['active', 'paused', 'budget_exhausted']);

/**
 * The missions module's task rules, passed in by the caller: this file is core
 * and core never imports a module (scripts/module-boundaries.test.ts). Callers
 * pass `@buildd/core/mission-helpers` itself, so the counts match every surface.
 */
export interface MissionTaskRules {
  computeMissionProgress: typeof computeMissionProgress;
  deriveTaskType: typeof deriveTaskType;
  isAttempt: typeof isAttempt;
}

/** A reviewer run is audit, not repair. */
const isRepairAttempt = (rules: MissionTaskRules) => (t: MissionTaskRow) => {
  const type = rules.deriveTaskType(t);
  return type !== 'review' && type !== 'review-retry';
};
/** Platform signals filed by agents; never the face of a mission outcome. */
const isFriction = (t: { title: string }) => /^\[friction\]/i.test(t.title.trim());

export function projectMissionDelivery(m: MissionDeliveryInput, rules: MissionTaskRules): MissionDelivery {
  const { computeMissionProgress, isAttempt } = rules;
  const progress = computeMissionProgress(m.tasks.map(t => ({ ...t, dependsOn: undefined, workers: (t.workers ?? []).map(w => ({ ...w })) })));
  const attempts = new Map<string, MissionTaskRow[]>();
  for (const t of m.tasks) {
    if (isAttempt(t) && t.parentTaskId) attempts.set(t.parentTaskId, [...(attempts.get(t.parentTaskId) ?? []), t]);
  }
  const roots = m.tasks.filter(t => !(isAttempt(t) && t.parentTaskId) && t.status !== 'cancelled');
  const byId = new Map(m.tasks.map(t => [t.id, t]));

  const first = roots.map(t => {
    const kids = attempts.get(t.id) ?? [];
    const repairs = kids.filter(isRepairAttempt(rules));
    // A live reviewer is the audit running, not a build or a repair: its
    // workers count as agents but never decide the task's kind.
    const workers = [...(t.workers ?? []), ...repairs.flatMap(k => k.workers ?? [])];
    const reviewers = kids.filter(k => !repairs.includes(k)).flatMap(k => k.workers ?? []);
    // An attempt that succeeded resolves the parent (computeMissionProgress's best-status rule).
    const status = kids.some(k => k.status === 'completed') && t.status === 'failed' ? 'completed' : t.status;
    return { t, workers, reviewers, status, repairRounds: repairs.length };
  });
  const landedIds = new Set<string>();
  const deliveries = first.map(({ t, workers, reviewers, status, repairRounds }) => {
    const r = m.reviews?.get(t.id);
    const delivery = projectTaskDelivery({ status, workers, repairRounds, review: r?.review, headSha: r?.headSha });
    if (delivery.landed) landedIds.add(t.id);
    return { t, workers, reviewers, status, repairRounds, delivery };
  });
  // Second pass: an unclaimed task whose in-mission dependency has not landed waits on it.
  for (const d of deliveries) {
    if (d.delivery.kind !== 'waiting') continue;
    const blocker = (d.t.dependsOn ?? []).find(id => byId.has(id) && !landedIds.has(id));
    if (blocker) d.delivery = { ...d.delivery, waitingOn: 'dependency' };
  }

  const tasks = deliveries.map(d => ({ id: d.t.id, title: d.t.title, delivery: d.delivery }));
  const allLanded = progress.totalTasks > 0 && progress.completedTasks >= progress.totalTasks;
  const anyLive = deliveries.some(d => [...d.workers, ...d.reviewers].some(w => LIVE.has(w.status)));
  const complete = m.status === 'completed';
  const onTrunk = m.integrationBranch ? complete : null;
  const milestones: MissionMilestones = {
    agentsDone: !anyLive && deliveries.length > 0 && deliveries.every(d => d.status === 'completed' || d.status === 'failed'),
    allLanded,
    onTrunk,
    complete,
    released: m.released ?? null,
  };

  const rank = (k: DeliveryKind) => MISSION_PRIORITY.indexOf(k);
  const candidates = tasks.filter(t => t.delivery.kind !== 'landed');
  const focusable = candidates.filter(t => !isFriction(t)).length > 0 ? candidates.filter(t => !isFriction(t)) : candidates;
  // A not-landed task a person must resolve outranks one still being reconciled.
  const focus = [...focusable].sort((a, b) => rank(a.delivery.kind) - rank(b.delivery.kind) || Number(a.delivery.reconciling) - Number(b.delivery.reconciling) || a.id.localeCompare(b.id))[0] ?? null;

  let kind: DeliveryKind;
  let exception: MissionDelivery['exception'] = null;
  if (complete) kind = 'landed';
  else if (m.isHeld) kind = 'held';
  else if (tasks.length === 0 || progress.totalTasks === 0) kind = 'planning';
  else if (allLanded && m.integrationBranch) {
    kind = 'landing';
    exception = { tone: 'info', text: 'All tasks done, not yet on trunk' };
  } else kind = focus?.delivery.kind ?? 'landed';

  if (!exception && focus) {
    if (focus.delivery.kind === 'notlanded') {
      exception = focus.delivery.reconciling
        ? { tone: 'warning', text: `The PR for ${focus.title} closed; checking automatically whether another PR carries it` }
        : { tone: 'error', text: `${focus.title} did not land and needs your decision` };
    }
    else if (focus.delivery.kind === 'unavailable') exception = { tone: 'warning', text: `The audit for ${focus.title} could not run; it retries on its own` };
    else if (kind === 'waiting') exception = { tone: 'muted', text: focus.delivery.waitingOn === 'dependency' ? 'Waiting on earlier work, not on you' : 'Waiting on capacity, not on you' };
  }

  const repairRounds = deliveries.reduce((n, d) => n + d.repairRounds, 0);
  const inAudit = tasks.filter(t => ['audit', 'repair', 'landing', 'unavailable'].includes(t.delivery.kind)).length;
  const { evidence, next } = describe(kind, focus, m, repairRounds);

  return {
    id: m.id,
    title: m.title,
    href: m.href,
    kind,
    open: OPEN_MISSION_STATUSES.has(m.status),
    landed: progress.completedTasks,
    total: progress.totalTasks,
    inAudit,
    executing: anyLive,
    repairRounds,
    milestones,
    focus: focus ? { id: focus.id, title: focus.title } : null,
    evidence,
    next,
    exception,
    reconciling: kind === 'notlanded' && !!focus?.delivery.reconciling,
    tasks,
  };
}

const REPAIR_WHY = { ci: 'CI failed', conflict: 'The branch conflicts with its base', review: 'Review asked for changes' } as const;

function describe(kind: DeliveryKind, focus: MissionDelivery['tasks'][number] | null, m: MissionDeliveryInput, rounds: number): { evidence: string; next: string } {
  const t = focus?.title ?? 'the next task';
  const d = focus?.delivery;
  switch (kind) {
    case 'landing':
      return d?.kind === 'landing'
        ? { evidence: `${t} is approved and green on its latest revision.`, next: `${t} lands` }
        : { evidence: 'Every task landed on the mission branch.', next: 'The mission PR merges to trunk' };
    case 'audit':
      return { evidence: `${t} has a PR open; review and CI have not both passed on its latest revision.`, next: `${t} lands` };
    case 'repair': {
      const why = d?.repairReason ? REPAIR_WHY[d.repairReason] : 'An audit failed';
      return { evidence: `${why} on ${t}. An automatic fix ${d && d.agentDone ? 'is queued' : 'is running'}${rounds > 0 ? ` (round ${rounds})` : ''}.`, next: `${t} goes back to audit` };
    }
    case 'build':
      return { evidence: `An agent is building ${t}.`, next: `${t} opens a PR` };
    case 'needs':
      return { evidence: `${t} is waiting on a decision.`, next: 'Your answer' };
    case 'unavailable':
      return { evidence: `The audit for ${t} could not run.`, next: 'The audit retries on its own' };
    case 'notlanded':
      return d?.reconciling
        ? { evidence: `The PR for ${t} closed without merging.`, next: 'Checking whether another PR carries it' }
        : { evidence: `${t} did not land: its PR was abandoned or the task failed.`, next: 'Open it to retry or drop it' };
    case 'waiting':
      return { evidence: `${t} has not started.`, next: d?.waitingOn === 'dependency' ? `After its dependencies land` : 'Starts when a slot frees up' };
    case 'held':
      return { evidence: 'Held by its owner.', next: 'Starts when armed' };
    case 'planning':
      return { evidence: 'No tasks planned yet.', next: 'A plan' };
    case 'landed':
      return { evidence: m.status === 'completed' ? 'Mission complete.' : 'Every task landed.', next: m.status === 'completed' ? 'Release' : 'Mission completes' };
  }
}

// ── Home selection ──────────────────────────────────────────────────────────

/** Closest to a delivery milestone first. Waiting, held, planning and exceptions never move. */
const MOVING: Partial<Record<DeliveryKind, number>> = { landing: 0, audit: 1, repair: 2, build: 3 };

/**
 * Home's "Moving toward delivery": up to `limit` open missions, chosen by how
 * close they are to their next delivery milestone — not by agent activity.
 */
export function selectHomeMilestones(missions: readonly MissionDelivery[], limit = 3): MissionDelivery[] {
  const share = (m: MissionDelivery) => (m.total > 0 ? m.landed / m.total : 0);
  return missions
    .filter(m => m.open && MOVING[m.kind] != null)
    .sort((a, b) => MOVING[a.kind]! - MOVING[b.kind]! || share(b) - share(a) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Open missions that are waiting or held: named on Home as "not listed, moves on its own". */
export function countQuietMissions(missions: readonly MissionDelivery[]): number {
  return missions.filter(m => m.open && (m.kind === 'waiting' || m.kind === 'held' || m.kind === 'planning')).length;
}

// ── Count contracts ─────────────────────────────────────────────────────────

/**
 * Three different numbers, never conflated:
 *   openMissions      — missions not completed or archived (not on trunk yet).
 *   executingMissions — open missions with at least one live agent.
 *   liveAgents/slots  — live workers / runner seats. Audits, CI and merges
 *                       are not agents unless a worker runs them.
 */
export interface DeliveryCounts {
  openMissions: number;
  executingMissions: number;
  liveAgents: number;
  slots: { used: number; total: number };
}

export function deliveryCounts(input: {
  missions: ReadonlyArray<{ status: string; liveAgents: number }>;
  liveAgents: number;
  capacity: number;
}): DeliveryCounts {
  const open = input.missions.filter(m => OPEN_MISSION_STATUSES.has(m.status));
  return {
    openMissions: open.length,
    executingMissions: open.filter(m => m.liveAgents > 0).length,
    liveAgents: input.liveAgents,
    slots: { used: input.liveAgents, total: input.capacity },
  };
}
