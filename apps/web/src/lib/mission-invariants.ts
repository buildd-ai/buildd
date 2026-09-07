/**
 * Mission-state invariants — the pure half of the hourly sweep.
 *
 * Eleven named records, each of which is a defect shape that actually shipped
 * and then sat unnoticed for hours or days because nothing in the system could
 * express it as a question. `deriveMissionHealth` answers "how is this mission
 * doing" from task counts; none of these eleven are visible in task counts.
 *
 * ── The check is code, the fix is an agent ──────────────────────────────────
 * Every predicate here is plain JavaScript over rows the caller already read.
 * A healthy fleet costs one set of queries per hour and spawns nothing — no
 * worker, no agent, no tokens. `lib/health-watcher.ts` is the precedent: it
 * files a task only on a real breach. Nothing in this module may ever evaluate
 * an invariant by asking a model.
 *
 * ── Reporting is not gating ────────────────────────────────────────────────
 * Same discipline as `api/cron/queue-stall`: this module withholds nothing from
 * anything. It names conditions. Ten of the eleven are report-only; exactly one
 * (`orphaned_integration_base`) files a task, because it is unambiguous, severe
 * and self-evidently actionable. Promoting another is a later diff per
 * invariant, and the bar is that it has been observed to fire on a real breach
 * AND stay quiet on a healthy fleet.
 *
 * ── Thresholds are the whole game ──────────────────────────────────────────
 * Most of these states are NORMAL for minutes and pathological for days. A
 * sweep that fires on healthy transients gets muted within a week, and a muted
 * sweep is worse than none — so every invariant carries its threshold next to
 * its query, with the reasoning in the comment above it.
 *
 * The DB reads and the bounded GitHub calls live in the route
 * (`api/cron/mission-invariants`), so every predicate below is unit-testable
 * against a constructed snapshot — both the violating state and the adjacent
 * healthy one.
 */

import { MISSION_BRANCH_PREFIX, isMissionPrTask } from '@buildd/core/mission-integration';

// ── Thresholds ──────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * `missions.workingBranch` is generated lazily, on the mission's first task —
 * so the flag being on with no branch is only a defect once a task exists to be
 * mis-based. 30m is generous against a write that happens in the same request
 * as task creation, and still catches the breach on the next hourly tick.
 */
export const INERT_INTEGRATION_BRANCH_MS = 30 * MIN;

/**
 * A deleted base is permanent and instantaneous — GitHub retargets the moment
 * the integration PR merges. The 30m grace is not for the condition to settle,
 * it is for OUR view of it: this is the one invariant that files a task, and a
 * PR opened seconds ago against a branch our webhook has not caught up on must
 * not page anyone.
 */
export const ORPHANED_INTEGRATION_BASE_MS = 30 * MIN;

/** Same shape of race as above: a PR's base ref is written at open time and refreshed by webhook. */
export const TASK_BASE_DRIFT_MS = 30 * MIN;

/**
 * A worker's branch is fixed at claim time and never changes, so there is no
 * transient at all. 15m exists only so a worker mid-claim is never reported.
 */
export const WORKER_ON_INTEGRATION_BRANCH_MS = 15 * MIN;

/**
 * Zero. The second merge IS the breach — one-merge-per-mission is not a state
 * that is allowed to persist briefly, it is a guarantee that has already been
 * broken by the time this can see it. A threshold here would only delay the
 * report of a fact that can no longer change.
 */
export const MISSION_MERGED_TWICE_MS = 0;

/**
 * Children are created synchronously when a planning task completes
 * (`resolveCompletedTask` → `approvePlan`). 2h covers the one legitimate delay:
 * `BUILDD_REQUIRE_PLAN_APPROVAL=1` makes a standalone plan wait for a human,
 * and a plan a human has not looked at within two hours is worth a line in a
 * report even then.
 */
export const PLAN_PRODUCED_NO_CHILDREN_MS = 2 * HOUR;

/**
 * The escalation already worked — a human owes the mission a decision and the
 * mission is parked until they give one. 24h is a working day: shorter would
 * re-report a question asked at 17:00 before anyone could plausibly answer it,
 * longer would let a mission sit a weekend.
 */
export const CRITERIA_ESCALATED_UNANSWERED_MS = 24 * HOUR;

/**
 * `create_pr` runs before `complete_task`, so a completed worker's PR number is
 * already set by the time it reports. 30m is pure slack for a PR registered
 * out-of-band (the `prUrl` adoption path) landing after completion.
 */
export const STRANDED_COMMITS_MS = 30 * MIN;

/**
 * Attribution edges are written when the release resolves its commit range, not
 * at dispatch. 2h is comfortably past a deploy plus its verification window.
 */
export const RELEASE_WITHOUT_HEAD_MS = 2 * HOUR;

/**
 * Releases dispatched before this instant are out of scope for the invariant.
 *
 * It is the merge of `fix(releases): require a head sha before healthy, record
 * direct-to-prod merges` (#2140) — the change that made "healthy implies a head
 * sha" true at all, and the later of the two guarantees this invariant checks
 * (the other being `fix(core): match squash-merge commits in release
 * attribution`, which landed a few days earlier). Rows dispatched before it
 * cannot have honoured either; they are known-bad and permanent, and reporting
 * them every hour forever is exactly how a sweep gets muted.
 *
 * A dispatched-before cutoff rather than a list of row ids: the exclusion is
 * then a statement about when the code changed, which is auditable from git,
 * instead of a hardcoded snapshot of one deployment's data.
 */
export const RELEASE_INVARIANT_CUTOFF = new Date('2026-09-06T12:04:00.000Z');

/**
 * The merge decision was made; carrying it out is a single API call. 2h allows
 * for the approve→merge handoff plus a required check that reported late, and
 * is short enough that "approved this morning, still open this afternoon" is
 * caught the same day.
 */
export const APPROVED_PR_UNMERGED_MS = 2 * HOUR;

/**
 * The limbo is EXPECTED for about twenty minutes after the last task completes
 * — the organizer's next cycle picks the mission up and evaluates its criteria.
 * 4h is an order of magnitude past that: it is four organizer cycles that all
 * declined to produce a verdict, which is a stuck mission rather than a settling
 * one.
 */
export const MISSION_UNVERIFIABLE_MS = 4 * HOUR;

// ── Shared vocabulary ───────────────────────────────────────────────────────

/** Task statuses that mean "this task is still owed". */
export const OPEN_TASK_STATUSES = new Set(['pending', 'assigned', 'in_progress', 'review']);

/** Worker PR lifecycle states that mean the PR is no longer open. */
const SETTLED_PR_LIFECYCLE = new Set(['merged', 'closed']);

/** Goal-criteria verdicts that actually decide something. Everything else is limbo. */
const DECIDED_VERDICTS = new Set(['pass', 'fail']);

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface SnapshotMission {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  integrationBranchEnabled: boolean;
  workingBranch: string | null;
  criteriaEscalatedAt: Date | null;
  hasGoalCriteria: boolean;
  /** `goalCriteriaState.overall`, or null when nothing has ever evaluated. */
  criteriaOverallVerdict: string | null;
  updatedAt: Date;
}

export interface SnapshotTask {
  id: string;
  workspaceId: string;
  missionId: string | null;
  parentTaskId: string | null;
  title: string;
  status: string;
  mode: string;
  taskClass: string;
  outputRequirement: string | null;
  /** `context.baseBranch` — where the task was TOLD to base its PR. */
  contextBaseBranch: string | null;
  /** `result.structuredOutput.plan`, verbatim — see {@link countPlanSteps}. */
  planRaw: unknown;
  /** Number of tasks whose `parentTaskId` is this task. */
  childCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnapshotWorker {
  id: string;
  taskId: string | null;
  workspaceId: string;
  status: string;
  /** The worker's own branch — the head of its PR. */
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  /** GitHub's base ref as buildd last recorded it. Null means unknown, never trunk. */
  prBaseRef: string | null;
  prLifecycleStatus: string | null;
  mergedAt: Date | null;
  commitCount: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SnapshotRelease {
  id: string;
  workspaceId: string;
  state: string;
  headSha: string | null;
  attributedTaskCount: number;
  dispatchedAt: Date | null;
  createdAt: Date;
}

export interface SnapshotNote {
  id: string;
  missionId: string | null;
  type: string;
  status: string;
  createdAt: Date;
}

export interface SnapshotReview {
  prNumber: number;
  workspaceId: string;
  /** The reviewer's verdict, from the newest review task for this PR. */
  verdict: string | null;
  decidedAt: Date;
}

export interface InvariantSnapshot {
  missions: SnapshotMission[];
  tasks: SnapshotTask[];
  workers: SnapshotWorker[];
  releases: SnapshotRelease[];
  notes: SnapshotNote[];
  reviews: SnapshotReview[];
  /**
   * `remoteRefKey(workspaceId, ref)` → does the ref exist on the remote.
   *
   * `true` exists, `false` gone, `null` or absent means NOT CHECKED. Absence
   * must never read as "gone": this map feeds the one invariant that files a
   * task, and an unreachable GitHub would otherwise file one per open PR.
   */
  remoteBranchExists: Map<string, boolean | null>;
  /** workspaceId → the branch names that count as trunk for that workspace. */
  trunkBranches: Map<string, Set<string>>;
}

export function remoteRefKey(workspaceId: string, ref: string): string {
  return `${workspaceId} ${ref}`;
}

export function emptySnapshot(): InvariantSnapshot {
  return {
    missions: [],
    tasks: [],
    workers: [],
    releases: [],
    notes: [],
    reviews: [],
    remoteBranchExists: new Map(),
    trunkBranches: new Map(),
  };
}

// ── Invariant records ───────────────────────────────────────────────────────

export type InvariantKey =
  | 'inert_integration_branch'
  | 'orphaned_integration_base'
  | 'task_base_drift'
  | 'worker_on_integration_branch'
  | 'mission_merged_twice'
  | 'plan_produced_no_children'
  | 'criteria_escalated_unanswered'
  | 'stranded_commits'
  | 'release_without_head'
  | 'approved_pr_unmerged'
  | 'mission_unverifiable';

export type EntityKind = 'mission' | 'task' | 'worker' | 'release' | 'pull_request';

export interface InvariantViolation {
  /** The id a reader opens. Combined with the key, this is the dedupe signature. */
  entityId: string;
  entityKind: EntityKind;
  workspaceId: string;
  /** One line of evidence about THIS row — never prose about the invariant. */
  detail: string;
  /** How long the breached state has been observable. */
  ageMs: number;
}

export interface Invariant {
  /** Stable — it becomes half of the dedupe signature. Never rename one. */
  key: InvariantKey;
  title: string;
  /** How long a transient state is allowed to persist before it counts. */
  thresholdMs: number;
  /** One line, written for whoever reads the report. */
  remedy: string;
  /** Whether a breach files a task. Exactly one invariant ships with this true. */
  files: boolean;
  /** The query. Pure: rows in, violations out. */
  query: (snapshot: InvariantSnapshot, now: Date) => InvariantViolation[];
}

export interface InvariantResult {
  key: InvariantKey;
  title: string;
  remedy: string;
  files: boolean;
  thresholdMs: number;
  violations: InvariantViolation[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function age(now: Date, at: Date | null | undefined): number | null {
  if (!at) return null;
  const ms = now.getTime() - at.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Has `at` been true for at least `thresholdMs`? A null anchor is never old enough. */
function olderThan(now: Date, at: Date | null | undefined, thresholdMs: number): number | null {
  const ms = age(now, at);
  if (ms === null || ms < thresholdMs) return null;
  return ms;
}

function isMissionBranch(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(MISSION_BRANCH_PREFIX);
}

/** An open PR as buildd records it: has a number, not merged, not settled. */
function isOpenPrWorker(w: SnapshotWorker): boolean {
  return (
    w.prNumber !== null &&
    w.mergedAt === null &&
    !SETTLED_PR_LIFECYCLE.has(w.prLifecycleStatus ?? '')
  );
}

function isTrunk(snapshot: InvariantSnapshot, workspaceId: string, ref: string | null): boolean {
  if (!ref) return false;
  const set = snapshot.trunkBranches.get(workspaceId);
  return set ? set.has(ref) : false;
}

function indexBy<T, K>(rows: T[], key: (row: T) => K | null): Map<K, T> {
  const map = new Map<K, T>();
  for (const row of rows) {
    const k = key(row);
    if (k !== null) map.set(k, row);
  }
  return map;
}

/**
 * How many steps a planning task's `structuredOutput.plan` carries.
 *
 * Deliberately looser than `extractPlan` in `lib/task-dependencies.ts`, which
 * is the GATE. This is the DETECTOR, and the class of defect it is built to
 * catch is exactly "the approval path could not read the plan" — so a plan the
 * gate rejects must still count as a plan here, or the sweep goes quiet on the
 * bug it exists to find. A JSON string that parses to an array counts.
 */
export function countPlanSteps(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

// ── The eleven ──────────────────────────────────────────────────────────────

export const INVARIANTS: Invariant[] = [
  {
    key: 'inert_integration_branch',
    title: 'Mission has integration branches enabled but no working branch',
    thresholdMs: INERT_INTEGRATION_BRANCH_MS,
    remedy:
      'The flag reads on and does nothing — task PRs are silently targeting trunk. ' +
      'Set the mission back to branchStrategy=mission-branch so the branch is created, or turn the flag off.',
    files: false,
    query: (s, now) => {
      const oldestTaskByMission = new Map<string, Date>();
      for (const t of s.tasks) {
        if (!t.missionId || t.status === 'cancelled') continue;
        const current = oldestTaskByMission.get(t.missionId);
        if (!current || t.createdAt < current) oldestTaskByMission.set(t.missionId, t.createdAt);
      }
      const out: InvariantViolation[] = [];
      for (const m of s.missions) {
        if (!m.integrationBranchEnabled) continue;
        if (m.workingBranch && m.workingBranch.trim()) continue;
        const ageMs = olderThan(now, oldestTaskByMission.get(m.id) ?? null, INERT_INTEGRATION_BRANCH_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: m.id,
          entityKind: 'mission',
          workspaceId: m.workspaceId,
          detail: `integrationBranchEnabled=true, workingBranch=NULL, oldest task ${Math.round(ageMs / HOUR)}h old`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'orphaned_integration_base',
    title: 'Open PR is based on a mission branch that no longer exists on the remote',
    thresholdMs: ORPHANED_INTEGRATION_BASE_MS,
    remedy:
      'The mission PR merged and delete-branch-on-merge removed the base, so GitHub retargeted this PR at trunk. ' +
      'Re-point it deliberately: retarget to trunk after re-reviewing the diff, or restore the branch and re-base.',
    files: true,
    query: (s, now) => {
      const out: InvariantViolation[] = [];
      for (const w of s.workers) {
        if (!isOpenPrWorker(w)) continue;
        if (!isMissionBranch(w.prBaseRef)) continue;
        const exists = s.remoteBranchExists.get(remoteRefKey(w.workspaceId, w.prBaseRef!));
        // Absent or null = not checked. Unknown is never "gone" — this is the
        // invariant that files, so a GitHub outage must produce silence.
        if (exists !== false) continue;
        const ageMs = olderThan(now, w.createdAt, ORPHANED_INTEGRATION_BASE_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: String(w.prNumber),
          entityKind: 'pull_request',
          workspaceId: w.workspaceId,
          detail: `PR #${w.prNumber} base '${w.prBaseRef}' is gone from the remote${w.prUrl ? ` (${w.prUrl})` : ''}`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'task_base_drift',
    title: 'Task was assigned a mission base but its PR now sits on trunk',
    thresholdMs: TASK_BASE_DRIFT_MS,
    remedy:
      'The review gate for this task moved without anyone deciding to move it. ' +
      'Confirm the retarget was intended; if not, re-base the PR onto the mission branch.',
    files: false,
    query: (s, now) => {
      const taskById = indexBy(s.tasks, t => t.id);
      const out: InvariantViolation[] = [];
      for (const w of s.workers) {
        if (!w.taskId || w.prNumber === null) continue;
        const t = taskById.get(w.taskId);
        if (!t) continue;
        if (!isMissionBranch(t.contextBaseBranch)) continue;
        // A null prBaseRef is UNKNOWN, and isTrunk() answers false for it —
        // guessing "trunk" here would invent a drift that may not exist.
        if (!isTrunk(s, w.workspaceId, w.prBaseRef)) continue;
        const ageMs = olderThan(now, w.createdAt, TASK_BASE_DRIFT_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: t.id,
          entityKind: 'task',
          workspaceId: t.workspaceId,
          detail: `context.baseBranch='${t.contextBaseBranch}' but PR #${w.prNumber} base is '${w.prBaseRef}'`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'worker_on_integration_branch',
    title: "Task worker's PR head is its own mission's integration branch",
    thresholdMs: WORKER_ON_INTEGRATION_BRANCH_MS,
    remedy:
      "One task's work is masquerading as the whole mission's. " +
      'Move the commits to a task branch and open a PR into the integration branch instead.',
    files: false,
    query: (s, now) => {
      const taskById = indexBy(s.tasks, t => t.id);
      const missionById = indexBy(s.missions, m => m.id);
      const out: InvariantViolation[] = [];
      for (const w of s.workers) {
        if (!w.taskId) continue;
        const t = taskById.get(w.taskId);
        if (!t?.missionId) continue;
        const m = missionById.get(t.missionId);
        const base = m?.workingBranch?.trim();
        if (!base || w.branch !== base) continue;
        // The mission-PR owner's head IS the integration branch, by design.
        if (isMissionPrTask({ title: t.title, taskClass: t.taskClass })) continue;
        const ageMs = olderThan(now, w.startedAt ?? w.createdAt, WORKER_ON_INTEGRATION_BRANCH_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: w.id,
          entityKind: 'worker',
          workspaceId: w.workspaceId,
          detail: `worker branch '${w.branch}' is mission ${t.missionId}'s integration branch (task ${t.id})`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'mission_merged_twice',
    title: 'Mission using an integration branch has more than one merged trunk PR',
    thresholdMs: MISSION_MERGED_TWICE_MS,
    remedy:
      'The one-merge-per-mission guarantee is broken — the merge-policy tier applied once but the work landed in several pieces. ' +
      'Check whether a retarget sent task PRs straight to trunk, and review what landed unreviewed.',
    files: false,
    query: (s, now) => {
      const taskById = indexBy(s.tasks, t => t.id);
      const missionById = indexBy(s.missions, m => m.id);
      // missionId → merged trunk PR numbers. A set: several worker rows can
      // carry the same PR number (retry chains), and that is one merge.
      const byMission = new Map<string, Set<number>>();
      const latestMergeAt = new Map<string, Date>();
      for (const w of s.workers) {
        if (!w.taskId || w.prNumber === null || !w.mergedAt) continue;
        const t = taskById.get(w.taskId);
        if (!t?.missionId) continue;
        const m = missionById.get(t.missionId);
        if (!m?.integrationBranchEnabled) continue;
        if (!isTrunk(s, w.workspaceId, w.prBaseRef)) continue;
        let set = byMission.get(t.missionId);
        if (!set) byMission.set(t.missionId, (set = new Set()));
        set.add(w.prNumber);
        const prev = latestMergeAt.get(t.missionId);
        if (!prev || w.mergedAt > prev) latestMergeAt.set(t.missionId, w.mergedAt);
      }
      const out: InvariantViolation[] = [];
      for (const [missionId, prs] of byMission) {
        if (prs.size < 2) continue;
        const m = missionById.get(missionId)!;
        const ageMs = age(now, latestMergeAt.get(missionId) ?? null) ?? 0;
        if (ageMs < MISSION_MERGED_TWICE_MS) continue;
        out.push({
          entityId: missionId,
          entityKind: 'mission',
          workspaceId: m.workspaceId,
          detail: `${prs.size} merged trunk PRs: ${[...prs].sort((a, b) => a - b).map(n => `#${n}`).join(', ')}`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'plan_produced_no_children',
    title: 'Completed planning task carries a plan and created no child tasks',
    thresholdMs: PLAN_PRODUCED_NO_CHILDREN_MS,
    remedy:
      'The plan exists but the approval path could not act on it (unreadable shape, or a human gate nobody answered). ' +
      'Re-approve it via POST /api/tasks/[id]/approve-plan, or re-run the planning task.',
    files: false,
    query: (s, now) => {
      const out: InvariantViolation[] = [];
      for (const t of s.tasks) {
        if (t.mode !== 'planning' || t.status !== 'completed') continue;
        const steps = countPlanSteps(t.planRaw);
        if (steps === 0 || t.childCount > 0) continue;
        const ageMs = olderThan(now, t.updatedAt, PLAN_PRODUCED_NO_CHILDREN_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: t.id,
          entityKind: 'task',
          workspaceId: t.workspaceId,
          detail: `${steps}-step plan, 0 child tasks, completed ${Math.round(ageMs / HOUR)}h ago`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'criteria_escalated_unanswered',
    title: 'Mission escalated its goal criteria and the question is still open',
    thresholdMs: CRITERIA_ESCALATED_UNANSWERED_MS,
    remedy:
      'The escalation worked; nobody was told. Answer the open question on the mission feed, or dismiss it and re-arm the criteria.',
    files: false,
    query: (s, now) => {
      const oldestOpenQuestion = new Map<string, Date>();
      for (const n of s.notes) {
        if (!n.missionId || n.type !== 'question' || n.status !== 'open') continue;
        const current = oldestOpenQuestion.get(n.missionId);
        if (!current || n.createdAt < current) oldestOpenQuestion.set(n.missionId, n.createdAt);
      }
      const out: InvariantViolation[] = [];
      for (const m of s.missions) {
        if (!m.criteriaEscalatedAt) continue;
        const asked = oldestOpenQuestion.get(m.id);
        if (!asked) continue;
        const ageMs = olderThan(now, asked, CRITERIA_ESCALATED_UNANSWERED_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: m.id,
          entityKind: 'mission',
          workspaceId: m.workspaceId,
          detail: `criteria escalated, open question unanswered for ${Math.round(ageMs / DAY)}d`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'stranded_commits',
    title: 'Completed worker wrote commits and opened no PR',
    thresholdMs: STRANDED_COMMITS_MS,
    remedy:
      'Code was written with nothing to land it, and the completion summary may claim otherwise. ' +
      'Open a PR from the worker branch, or re-run the task.',
    files: false,
    query: (s, now) => {
      const taskById = indexBy(s.tasks, t => t.id);
      const out: InvariantViolation[] = [];
      for (const w of s.workers) {
        if (w.status !== 'completed' || w.prNumber !== null) continue;
        if ((w.commitCount ?? 0) <= 0) continue;
        const t = w.taskId ? taskById.get(w.taskId) : undefined;
        // An explicit "this task owes no output" is a decision, not a defect.
        if (t?.outputRequirement === 'none') continue;
        const ageMs = olderThan(now, w.completedAt, STRANDED_COMMITS_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: w.id,
          entityKind: 'worker',
          workspaceId: w.workspaceId,
          detail: `${w.commitCount} commit(s) on '${w.branch}', no PR number${t ? ` (task ${t.id})` : ''}`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'release_without_head',
    title: 'Release is missing its head SHA or has no attributed tasks',
    thresholdMs: RELEASE_WITHOUT_HEAD_MS,
    remedy:
      'Nothing can say what shipped in this release. Re-resolve its commit range, or mark the release failed if it never deployed.',
    files: false,
    query: (s, now) => {
      const out: InvariantViolation[] = [];
      for (const r of s.releases) {
        const anchor = r.dispatchedAt ?? r.createdAt;
        // Rows that predate the head-sha/attribution guarantees were never
        // going to honour them; see RELEASE_INVARIANT_CUTOFF.
        if (anchor < RELEASE_INVARIANT_CUTOFF) continue;
        // A failed release shipped nothing by definition.
        if (r.state === 'failed') continue;
        const missingHead = r.state === 'healthy' && !r.headSha;
        const missingEdges = r.attributedTaskCount === 0;
        if (!missingHead && !missingEdges) continue;
        const ageMs = olderThan(now, anchor, RELEASE_WITHOUT_HEAD_MS);
        if (ageMs === null) continue;
        const reasons = [
          missingHead ? "state='healthy' with head_sha=NULL" : null,
          missingEdges ? 'zero attribution edges' : null,
        ].filter(Boolean);
        out.push({
          entityId: r.id,
          entityKind: 'release',
          workspaceId: r.workspaceId,
          detail: `${reasons.join(' + ')} (state='${r.state}')`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'approved_pr_unmerged',
    title: 'Approved, green PR is still open',
    thresholdMs: APPROVED_PR_UNMERGED_MS,
    remedy:
      'The merge decision was made and nothing carried it out. Merge it, or record why the policy is refusing.',
    files: false,
    query: (s, now) => {
      const openPrs = new Map<string, SnapshotWorker>();
      for (const w of s.workers) {
        if (!isOpenPrWorker(w)) continue;
        openPrs.set(`${w.workspaceId} ${w.prNumber}`, w);
      }
      const out: InvariantViolation[] = [];
      for (const r of s.reviews) {
        if (r.verdict !== 'approve') continue;
        const w = openPrs.get(`${r.workspaceId} ${r.prNumber}`);
        if (!w) continue;
        // Green means green locally. A PR whose checks are still running or
        // failing is not waiting on the merge — it is waiting on CI.
        if (w.prLifecycleStatus !== 'ci_green') continue;
        const ageMs = olderThan(now, r.decidedAt, APPROVED_PR_UNMERGED_MS);
        if (ageMs === null) continue;
        out.push({
          entityId: String(r.prNumber),
          entityKind: 'pull_request',
          workspaceId: r.workspaceId,
          detail: `approved ${Math.round(ageMs / HOUR)}h ago, checks green, still open${w.prUrl ? ` (${w.prUrl})` : ''}`,
          ageMs,
        });
      }
      return out;
    },
  },

  {
    key: 'mission_unverifiable',
    title: 'Active mission has no open deliverable work and no criteria verdict',
    thresholdMs: MISSION_UNVERIFIABLE_MS,
    remedy:
      'Awaiting-verification limbo — nothing will move this mission on its own. ' +
      'Run manage_missions action=evaluate, or complete/close the mission by hand.',
    files: false,
    query: (s, now) => {
      const openDeliverable = new Set<string>();
      const anyTask = new Set<string>();
      const lastActivity = new Map<string, Date>();
      for (const t of s.tasks) {
        if (!t.missionId) continue;
        anyTask.add(t.missionId);
        const prev = lastActivity.get(t.missionId);
        if (!prev || t.updatedAt > prev) lastActivity.set(t.missionId, t.updatedAt);
        // Bookkeeping tasks (the mission PR) are not deliverable work: a
        // mission whose only remaining task ships the branch is still in limbo
        // with respect to its criteria.
        if (t.taskClass === 'work' && OPEN_TASK_STATUSES.has(t.status)) openDeliverable.add(t.missionId);
      }
      const out: InvariantViolation[] = [];
      for (const m of s.missions) {
        if (m.status !== 'active') continue;
        if (!anyTask.has(m.id)) continue;
        if (openDeliverable.has(m.id)) continue;
        if (m.criteriaOverallVerdict && DECIDED_VERDICTS.has(m.criteriaOverallVerdict)) continue;
        const anchor = lastActivity.get(m.id) ?? m.updatedAt;
        const ageMs = olderThan(now, anchor, MISSION_UNVERIFIABLE_MS);
        if (ageMs === null) continue;
        const verdict = m.criteriaOverallVerdict
          ? `verdict='${m.criteriaOverallVerdict}'`
          : m.hasGoalCriteria
            ? 'criteria declared, never evaluated'
            : 'no goal criteria declared';
        out.push({
          entityId: m.id,
          entityKind: 'mission',
          workspaceId: m.workspaceId,
          detail: `active, 0 open deliverable tasks, ${verdict}, idle ${Math.round(ageMs / HOUR)}h`,
          ageMs,
        });
      }
      return out;
    },
  },
];

const BY_KEY = new Map<InvariantKey, Invariant>(INVARIANTS.map(i => [i.key, i]));

export function invariantByKey(key: InvariantKey): Invariant {
  const inv = BY_KEY.get(key);
  if (!inv) throw new Error(`unknown invariant key: ${key}`);
  return inv;
}

/**
 * Run every invariant. Always returns one result per invariant, INCLUDING the
 * clean ones — a report that omits them cannot be told apart from a report
 * whose queries silently stopped matching anything.
 */
export function evaluateInvariants(snapshot: InvariantSnapshot, now: Date): InvariantResult[] {
  return INVARIANTS.map(inv => {
    let violations: InvariantViolation[] = [];
    try {
      violations = inv.query(snapshot, now);
    } catch (err) {
      // One broken predicate must not blind the other ten.
      console.error(`[mission-invariants] ${inv.key} threw:`, err);
      violations = [
        {
          entityId: inv.key,
          entityKind: 'mission',
          workspaceId: '',
          detail: `query errored: ${err instanceof Error ? err.message : String(err)}`,
          ageMs: 0,
        },
      ];
    }
    return {
      key: inv.key,
      title: inv.title,
      remedy: inv.remedy,
      files: inv.files,
      thresholdMs: inv.thresholdMs,
      violations,
    };
  });
}

export interface ScanCoverage {
  missions: number;
  tasks: number;
  workers: number;
  releases: number;
  notes: number;
  remoteRefs: number;
}

function humanThreshold(ms: number): string {
  if (ms === 0) return 'none';
  if (ms >= DAY) return `${Math.round(ms / DAY)}d`;
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / MIN)}m`;
}

/**
 * The report. Text an agent can read and a human can skim — no dashboard, no
 * charts, no new UI surface. The consumer is a task-filing agent.
 *
 * The `scanned` line is load-bearing: this repo has a documented history of
 * signals that were green over an empty set, and "0 breaches" over 0 rows is
 * not the same claim as "0 breaches" over a full fleet.
 */
export function formatInvariantReport(
  results: InvariantResult[],
  opts: { scanned: ScanCoverage },
): string {
  const { scanned } = opts;
  const total = results.reduce((n, r) => n + r.violations.length, 0);
  const empty =
    scanned.missions === 0 && scanned.tasks === 0 && scanned.workers === 0 && scanned.releases === 0;

  const lines: string[] = [];
  lines.push(`mission invariant sweep — ${total} violation(s) across ${results.length} invariants`);
  lines.push(
    `scanned: ${scanned.missions} missions, ${scanned.tasks} tasks, ${scanned.workers} workers, ` +
      `${scanned.releases} releases, ${scanned.notes} notes, ${scanned.remoteRefs} remote refs`,
  );
  if (empty) {
    lines.push(
      'EMPTY SCAN — every query ran against no rows, so a clean result proves nothing about the fleet.',
    );
  }
  lines.push('');

  for (const r of results) {
    const stage = r.files ? 'files' : 'report-only';
    const head = `${r.key}: ${r.violations.length} — ${r.title} [threshold ${humanThreshold(r.thresholdMs)}, ${stage}]`;
    if (r.violations.length === 0) {
      lines.push(`OK  ${head}`);
      continue;
    }
    lines.push(`!!  ${head}`);
    for (const v of r.violations) {
      lines.push(`      - ${v.entityKind} ${v.entityId} — ${v.detail}`);
    }
    lines.push(`    remedy: ${r.remedy}`);
  }

  return lines.join('\n');
}
