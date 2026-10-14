/**
 * The `?state=mission-task-strip` dev fixture and the parity test's tasks: a
 * mission Board whose Landed strip has something to select.
 *
 *   &variant=mid-open     nine landed, one open in the middle (a local mission)
 *   &variant=all-landed   everything landed: the drawer opens on the last task
 *   &variant=states       one task per action state: queued, failed, blocked, landed
 *   &variant=linear       A→B→C→D→E (strip spec §7.1)
 *   &variant=fan-out      A→{B, C, D} (§7.2)
 *   &variant=fan-in       {B, C}→D (§7.3)
 *   &variant=field        the 14-cell field case (§7.8)
 *   &variant=wide         one root, 30 dependents (§7.10)
 *   &variant=delivery     35 tasks in a chain, 33 landed; 34 on its second
 *                         automatic repair, 35 held behind it. The drawer's
 *                         Build › Audit › Land row and its Audit and repair
 *                         disclosure (`missionTaskDeliveries`).
 *   &variant=overview-2|overview-10|overview-20|overview-64
 *                         the Overview tab's Done / In progress / Waiting groups
 *                         (spec f7f67f1a R-1, R-5): mixed waiting causes, and a
 *                         surface audit in the checks group from 10 tasks up
 *   &select=<letter>      a DAG variant opens with that task selected
 *
 * Illustrative rows only (made-up ids and titles), built through the real
 * `buildMissionBoard`, so the strip reads exactly what the mission page reads.
 */
import * as missionHelpers from '@buildd/core/mission-helpers';
import { SURFACE_AUDIT_TITLE_PREFIX } from '@buildd/core/surface-audit';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel, type MissionGateFacts } from '@/lib/mission-board';
import type { TaskDeliveryDetail } from '@/lib/activity-delivery';
import { missionTaskDeliveries, type MissionDeliveryTaskRow } from '@/app/app/(protected)/missions/[id]/mission-task-delivery';
import type { MissionExecutor } from '@/lib/task-actions';
import type { MissionChecksSource } from '@/app/app/(protected)/missions/[id]/MissionOverview';
import type { MissionVisualReviewState } from '@/lib/workflow/visual-review-state';
import { MISSION_TASK_STRIP_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_TASK_STRIP_STATE = MISSION_TASK_STRIP_FIXTURE_STATE;
export const MISSION_TASK_STRIP_VARIANTS = [
  'mid-open', 'all-landed', 'states', 'linear', 'fan-out', 'fan-in', 'field', 'wide', 'delivery', 'overview-2', 'overview-10', 'overview-20', 'overview-64',
  'handoff-building', 'handoff-verifying', 'handoff-repairing', 'handoff-approval', 'handoff-reviewer', 'handoff-delivered', 'handoff-deploy-failed', 'handoff-budget', 'handoff-local',
] as const;
export type MissionTaskStripVariant = (typeof MISSION_TASK_STRIP_VARIANTS)[number];

export function parseMissionTaskStripVariant(q: URLSearchParams): MissionTaskStripVariant {
  const v = q.get('variant');
  return (MISSION_TASK_STRIP_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionTaskStripVariant) : 'mid-open';
}

export function missionTaskStripLinks(): { label: string; href: string }[] {
  return MISSION_TASK_STRIP_VARIANTS.map(v => ({ label: `strip: ${v}`, href: `?state=${MISSION_TASK_STRIP_STATE}&variant=${v}` }));
}

/** Made-up but valid UUIDs, so the drawer's links and short ids look real. */
export const stripFixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;

function worker(id: string, over: Partial<BoardWorkerInput>): BoardWorkerInput {
  return {
    id, status: 'completed', runner: 'alpha', startedAt: min(1), completedAt: min(8), updatedAt: min(8),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}

function task(n: number, title: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  const workers = over.workers ?? [];
  const first = workers[0];
  return {
    id: stripFixtureId(n), title, status: 'pending', taskClass: 'work',
    createdAt: new Date(T0 + n * 1000), missionPhaseIndex: 1, missionPhaseLabel: 'Build it',
    roleSlug: 'builder', outputRequirement: 'pr_required', backend: 'claude', workers,
    worker: first ? {
      status: first.status, startedAt: first.startedAt ? new Date(first.startedAt) : null,
      updatedAt: first.updatedAt ? new Date(first.updatedAt) : null, prNumber: first.prNumber,
      prUrl: first.prUrl, prLifecycleStatus: first.prLifecycleStatus, mergedAt: first.mergedAt ? new Date(first.mergedAt) : null,
    } : null,
    ...over,
  };
}

function landed(n: number, title: string): BoardTaskInput {
  const pr = 400 + n;
  return task(n, title, {
    status: 'completed',
    workers: [worker(`w${n}`, {
      startedAt: min(n * 3), completedAt: min(n * 3 + 2), updatedAt: min(n * 3 + 2), mergedAt: min(n * 3 + 2),
      prNumber: pr, prUrl: `https://github.com/example/app/pull/${pr}`, prLifecycleStatus: 'merged',
    })],
  });
}

const TITLES = [
  'feat(runner): agent loop skeleton', 'feat(runner): tool call bridge', 'feat(runner): session storage',
  'feat(runner): streaming output', 'fix(runner): retry on rate limit', 'feat(runner): workspace checkout',
  'feat(runner): heartbeat', 'docs(runner): setup guide', 'feat(runner): claim from a session', 'test(runner): end-to-end smoke',
];

/** What a fixture hands the Board: the model, the mission's executor, and nothing else. */
export interface MissionTaskStripFixture {
  model: MissionBoardModel;
  executor: MissionExecutor;
  /** Per-task delivery, as the page builds it; absent on the older variants. */
  deliveries?: Record<string, TaskDeliveryDetail>;
  /** The Overview's checks after the build (handoff variants). */
  checks?: MissionChecksSource;
  expectedMinutes?: Record<string, number>;
  held?: boolean;
}

export function missionTaskStripFixture(variant: MissionTaskStripVariant, now = min(60)): MissionTaskStripFixture {
  const base = { now, missionCreatedAt: T0, missionStatus: 'active' as const };
  if (variant === 'all-landed') {
    return {
      model: buildMissionBoard({ ...base, tasks: TITLES.map((t, i) => landed(i + 1, t)), missionStatus: 'completed', missionCompletedAt: min(40) }),
      executor: 'runner',
    };
  }
  if (variant === 'delivery') return deliveryFixture(base);
  if (isOverviewVariant(variant)) return { model: overviewWavesBoard(overviewSize(variant), now), executor: 'runner' };
  if (isHandoffVariant(variant)) return handoffFixture(variant, base);
  if (isDagVariant(variant)) {
    return { model: buildMissionBoard({ ...base, tasks: dagTasks(DAG_SPECS[variant]) }), executor: 'runner' };
  }
  if (variant === 'states') {
    return {
      model: buildMissionBoard({
        ...base,
        tasks: [
          landed(1, 'feat(app): landed work'),
          task(2, 'feat(app): queued on a runner'),
          task(3, 'feat(app): failed on claude', {
            status: 'failed',
            workers: [worker('w3', { status: 'failed', startedAt: min(5), completedAt: min(9), updatedAt: min(9) })],
          }),
          task(4, 'feat(app): waits for the queued task', { dependsOn: [stripFixtureId(2)] }),
        ],
      }),
      executor: 'runner',
    };
  }
  // mid-open: nine landed, the claim task open (a local mission's task).
  return {
    model: buildMissionBoard({
      ...base,
      tasks: TITLES.map((t, i) => (i === 8 ? task(i + 1, t) : landed(i + 1, t))),
    }),
    executor: 'local',
  };
}

/**
 * `?state=surface-audit-waiver`: a mission whose `[surface audit]` waits on a
 * running builder task, the audit's drawer open. The audit is task 3.
 */
export const SURFACE_AUDIT_FIXTURE_TASK = stripFixtureId(3);
export function surfaceAuditStripFixture(now = min(60)): MissionTaskStripFixture {
  return {
    model: buildMissionBoard({
      now,
      missionCreatedAt: T0,
      missionStatus: 'active',
      tasks: [
        landed(1, 'feat(app): mission card layout'),
        task(2, 'feat(app): task list polish', {
          status: 'in_progress',
          workers: [worker('w2', { status: 'running', completedAt: null, currentAction: 'Editing files' })],
        }),
        task(3, '[surface audit] Fixture mission', {
          roleSlug: 'visual-auditor', outputRequirement: 'artifact_required', kind: 'observation',
          dependsOn: [stripFixtureId(2)],
        }),
      ],
    }),
    executor: 'runner',
  };
}

// ── Dependency shapes (docs/specs/mission-progress-strip-ordering.md §7) ─────

export type DagState = 'landed' | 'review' | 'running' | 'pending' | 'failed';

export interface DagSpec {
  /** Tasks in creation order, one letter (or token) each. */
  tasks: readonly string[];
  /** Task → the tasks it depends on. */
  edges?: Readonly<Record<string, readonly string[]>>;
  /** Task → state; absent is pending. */
  states?: Readonly<Record<string, DagState>>;
  /** Task → dependency ids outside the mission. */
  external?: Readonly<Record<string, readonly string[]>>;
}

/** The fixture id of a DAG task, by its token's index in `spec.tasks`. */
export const dagId = (spec: Pick<DagSpec, 'tasks'>, name: string) => stripFixtureId(spec.tasks.indexOf(name) + 1);

/** One board row per token, built through the real `buildMissionBoard` inputs. */
export function dagTasks(spec: DagSpec): BoardTaskInput[] {
  return spec.tasks.map((name, i) => {
    const n = i + 1;
    const dependsOn = [...(spec.edges?.[name] ?? []).map(d => dagId(spec, d)), ...(spec.external?.[name] ?? [])];
    const over: Partial<BoardTaskInput> = { label: name, dependsOn: dependsOn.length ? dependsOn : null };
    const title = `feat: task ${name}`;
    switch (spec.states?.[name] ?? 'pending') {
      case 'landed':
        return { ...landed(n, title), ...over };
      case 'review': {
        const pr = 400 + n;
        return task(n, title, {
          ...over,
          status: 'completed',
          workers: [worker(`w${n}`, { prNumber: pr, prUrl: `https://github.com/example/app/pull/${pr}`, prLifecycleStatus: 'ci_green' })],
        });
      }
      case 'running':
        return task(n, title, { ...over, status: 'in_progress', workers: [worker(`w${n}`, { status: 'running', completedAt: null, currentAction: 'Editing files' })] });
      case 'failed':
        return task(n, title, { ...over, status: 'failed', workers: [worker(`w${n}`, { status: 'failed' })] });
      default:
        return task(n, title, over);
    }
  });
}

export function dagBoard(spec: DagSpec, extra: Partial<Parameters<typeof buildMissionBoard>[0]> = {}): MissionBoardModel {
  return buildMissionBoard({ now: min(60), missionCreatedAt: T0, missionStatus: 'active', tasks: dagTasks(spec), ...extra });
}

const letters = (s: string) => s.split('');

export const DAG_SPECS = {
  linear: { tasks: letters('ABCDE'), edges: { B: ['A'], C: ['B'], D: ['C'], E: ['D'] }, states: { A: 'landed', B: 'running' } },
  'fan-out': { tasks: letters('ABCD'), edges: { B: ['A'], C: ['A'], D: ['A'] }, states: { A: 'running' } },
  'fan-in': { tasks: letters('BCD'), edges: { D: ['B', 'C'] }, states: { B: 'review', C: 'running' } },
  field: {
    tasks: letters('ABCDEFGHIJKLMN'),
    edges: {
      B: ['A'], C: ['B'], F: ['A'], E: ['C'], G: ['C'], H: ['E'], I: ['G'], J: ['H'], L: ['I'], K: ['J'], M: ['K', 'L'],
      D: letters('CEFGHIJKLM'), N: ['D'],
    },
    states: { A: 'landed', B: 'landed', C: 'landed', F: 'landed', E: 'running' },
  },
  wide: {
    tasks: ['A', ...Array.from({ length: 30 }, (_, i) => `B${i + 1}`)],
    edges: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`B${i + 1}`, ['A']])),
    states: { A: 'running' },
  },
} satisfies Record<string, DagSpec>;

export type DagVariant = keyof typeof DAG_SPECS;
export const isDagVariant = (v: string): v is DagVariant => v in DAG_SPECS;

/** The task a DAG variant opens on (`&select=`), or null. */
export function dagSelection(variant: MissionTaskStripVariant, q: URLSearchParams): string | null {
  const name = q.get('select');
  if (!name || !isDagVariant(variant)) return null;
  const spec: DagSpec = DAG_SPECS[variant];
  return spec.tasks.includes(name) ? dagId(spec, name) : null;
}

// ── Delivery: 35 tasks, 2 remaining (the mission-detail phase/repair design) ──

/** The strip cell numbers the delivery variant is about. */
export const DELIVERY_REPAIRING = 34;
export const DELIVERY_HELD = 35;
const H1 = 'a1b2c3d4e5f6a7b8';
const H2 = 'd4e5f60718293a4b';

type DeliveryWorker = BoardWorkerInput & { lastCommitSha?: string | null };
type DeliveryRow = BoardTaskInput & MissionDeliveryTaskRow & { workers: DeliveryWorker[] };

/**
 * Rows for both readers: the Board folds the attempts under 34 (one cell), and
 * the delivery projection reads them as 34's audit and repair evidence.
 * Review verdicts ride on the digest, exactly as the page loads them.
 */
export function deliveryFixtureRows(): { rows: DeliveryRow[]; digests: Map<string, { result: unknown; context: unknown }> } {
  const chain = (n: number) => (n > 1 ? [stripFixtureId(n - 1)] : null);
  const rows: DeliveryRow[] = [];
  for (let n = 1; n <= 33; n++) rows.push({ ...landed(n, `feat(billing): export step ${String(n).padStart(2, '0')}`), dependsOn: chain(n) } as DeliveryRow);
  const pr = 400 + DELIVERY_REPAIRING;
  const id34 = stripFixtureId(DELIVERY_REPAIRING);
  rows.push(task(DELIVERY_REPAIRING, 'feat(billing): scheduled export email', {
    status: 'completed', dependsOn: chain(DELIVERY_REPAIRING),
    workers: [worker('w34', {
      startedAt: min(30), completedAt: min(36), updatedAt: min(50),
      prNumber: pr, prUrl: `https://github.com/example/app/pull/${pr}`, prLifecycleStatus: 'ci_failed', lastCommitSha: H1,
    } as Partial<DeliveryWorker>)],
  }) as DeliveryRow);
  const attempt = (n: number, title: string, over: Partial<BoardTaskInput>) =>
    rows.push(task(n, title, { taskClass: 'attempt', parentTaskId: id34, missionPhaseIndex: null, ...over }) as DeliveryRow);
  attempt(101, '[reviewer #1] feat(billing): scheduled export email', {
    status: 'completed', roleSlug: 'reviewer', workers: [worker('w101', { startedAt: min(37), completedAt: min(40), updatedAt: min(40) })],
  });
  attempt(102, '[builder · after review #1] feat(billing): scheduled export email', {
    status: 'completed', workers: [worker('w102', { startedAt: min(41), completedAt: min(48), updatedAt: min(48), lastCommitSha: H2 } as Partial<DeliveryWorker>)],
  });
  attempt(103, '[builder · after CI #1] feat(billing): scheduled export email', {
    status: 'in_progress', workers: [worker('w103', { status: 'running', startedAt: min(52), completedAt: null, updatedAt: min(58), currentAction: 'Fixing the failing export test' })],
  });
  rows.push(task(DELIVERY_HELD, 'feat(billing): export settings UI', { dependsOn: [id34] }) as DeliveryRow);
  const digests = new Map<string, { result: unknown; context: unknown }>([
    [stripFixtureId(101), { result: { effectiveVerdict: 'request-changes' }, context: { headSha: H1 } }],
  ]);
  return { rows, digests };
}

function deliveryFixture(base: { now: number; missionCreatedAt: number; missionStatus: 'active' }): MissionTaskStripFixture {
  const { rows, digests } = deliveryFixtureRows();
  const deliveries = missionTaskDeliveries({
    mission: { id: stripFixtureId(900), title: 'Billing exports: CSV and scheduled email', status: 'active' },
    tasks: rows,
    digestOf: id => digests.get(id) ?? { result: null, context: null },
    rules: missionHelpers,
  });
  return { model: buildMissionBoard({ ...base, tasks: rows }), executor: 'runner', deliveries };
}

// ── Overview groups (spec f7f67f1a R-1, R-5) ──────────────────────────────────

export const OVERVIEW_SIZES = [2, 10, 20, 64] as const;
export type OverviewVariant = `overview-${(typeof OVERVIEW_SIZES)[number]}`;
export const isOverviewVariant = (v: string): v is OverviewVariant => v.startsWith('overview-');
export const overviewSize = (v: OverviewVariant) => Number(v.slice('overview-'.length));

/**
 * `n` build tasks: about half landed, two building, and the rest waiting for
 * each of the causes the Overview tells apart: on another task (`dep`), for a
 * free runner (`slot`), on a hold (`hold`, a mission budget) and on a cause
 * nobody recorded (`unknown`). From 10 tasks up, a surface audit sits in the
 * checks group. `kinds` says which cause each waiting task was given.
 */
export function overviewWavesInput(n: number): { tasks: BoardTaskInput[]; gateFacts: MissionGateFacts; kinds: Record<string, 'dep' | 'slot' | 'hold' | 'unknown'> } {
  const tasks: BoardTaskInput[] = [];
  const kinds: Record<string, 'dep' | 'slot' | 'hold' | 'unknown'> = {};
  const waitingKinds: Record<string, MissionGateFacts['waitingKinds'][string]> = {};
  const running = n >= 4 ? 2 : 1;
  const done = n <= 2 ? 1 : Math.floor(n / 2);
  const title = (i: number) => `feat(reports): part ${String(i).padStart(2, '0')}`;
  for (let i = 1; i <= done; i++) tasks.push(landed(i, title(i)));
  for (let i = done + 1; i <= done + running; i++) {
    tasks.push(task(i, title(i), { status: 'in_progress', workers: [worker(`w${i}`, { status: 'running', completedAt: null, currentAction: 'Editing files' })] }));
  }
  const firstRunning = stripFixtureId(done + 1);
  const cycle = ['dep', 'slot', 'dep', 'hold', 'unknown'] as const;
  for (let i = done + running + 1, k = 0; i <= n; i++, k++) {
    const kind = cycle[k % cycle.length];
    const id = stripFixtureId(i);
    kinds[id] = kind;
    if (kind === 'dep') {
      tasks.push(task(i, title(i), { dependsOn: [firstRunning] }));
      waitingKinds[id] = 'dep_declared';
    } else {
      tasks.push(task(i, title(i)));
      if (kind === 'slot') waitingKinds[id] = 'workspace_cap';
      if (kind === 'hold') waitingKinds[id] = 'mission_budget';
      if (kind === 'unknown') waitingKinds[id] = 'unknown';
    }
  }
  if (n >= 10) tasks.push(task(n + 1, `${SURFACE_AUDIT_TITLE_PREFIX}Reports`, { roleSlug: 'visual-auditor', outputRequirement: 'artifact_required', dependsOn: [firstRunning] }));
  return { tasks, gateFacts: { releasedEdges: [], waitingKinds }, kinds };
}

export function overviewWavesBoard(n: number, now = min(60)): MissionBoardModel {
  const { tasks, gateFacts } = overviewWavesInput(n);
  return buildMissionBoard({ now, missionCreatedAt: T0, missionStatus: 'active', tasks, gateFacts });
}

// ── Handoff: Build complete, checks and delivery (spec f7f67f1a R-11 to R-24) ──

export type HandoffVariant = Extract<MissionTaskStripVariant, `handoff-${string}`>;
export const isHandoffVariant = (v: string): v is HandoffVariant => v.startsWith('handoff-');

function visualState(over: Partial<MissionVisualReviewState>): MissionVisualReviewState {
  return {
    status: 'running', blocksCompletion: true, blocksMerge: true, pendingVerification: true, staleEvidence: false, nextActor: 'system',
    policy: { mode: 'automatic', origin: 'workspace', waiverAllowed: true, locked: false },
    scope: { screens: 8, uiFiles: 4, source: 'diff', workLanded: true },
    progress: { captured: 6, expected: 8 },
    auditTaskId: stripFixtureId(950),
    branch: { headSha: 'a1b2c3d4e5f6a7b8', base: 'dev', integrationPr: { number: 128, stage: 'open' }, postMergeRecovery: false },
    ...over,
  };
}

/**
 * Ten build tasks and the checks after them, one variant per prototype
 * screen: building (with a build-only estimate), verifying, repairing (a
 * visual fix inside the check), the final merge under each tier, delivered,
 * a failed deploy, and the budget and local-session holds.
 */
export function handoffFixture(variant: HandoffVariant, base: { now: number; missionCreatedAt: number; missionStatus: 'active' }): MissionTaskStripFixture {
  const building = variant === 'handoff-building' || variant === 'handoff-budget' || variant === 'handoff-local';
  const tasks: BoardTaskInput[] = TITLES.map((t, i) => (building && i >= 6
    ? task(i + 1, t, i === 6 ? { status: 'in_progress', workers: [worker(`w${i + 1}`, { status: 'running', completedAt: null, currentAction: 'Editing files' })] } : {})
    : landed(i + 1, t)));
  tasks.push(task(950, `${SURFACE_AUDIT_TITLE_PREFIX}Mission handoff`, building ? {} : { status: 'in_progress', workers: [worker('w950', { status: 'running', completedAt: null, currentAction: 'Capturing screens' })] }));
  if (variant === 'handoff-repairing') {
    tasks.push(task(951, '[surface fix] /app/reports: filter selection resets after a refresh', { status: 'in_progress', workers: [worker('w951', { status: 'running', completedAt: null, currentAction: 'Editing files' })] }));
  }
  const model = buildMissionBoard({ ...base, tasks, missionStatus: variant === 'handoff-budget' ? 'budget_exhausted' as 'active' : base.missionStatus });

  const merged = variant === 'handoff-delivered' || variant === 'handoff-deploy-failed';
  const ready = variant === 'handoff-approval' || variant === 'handoff-reviewer';
  const prStage = merged ? 'merged' as const : ready ? 'ready' as const : 'open' as const;
  const branch = { headSha: 'a1b2c3d4e5f6a7b8', base: 'dev', integrationPr: { number: 128, stage: prStage }, postMergeRecovery: false };
  const visual: MissionVisualReviewState = building
    ? visualState({ status: 'needed', progress: undefined, branch })
    : variant === 'handoff-verifying'
      ? visualState({ branch })
      : variant === 'handoff-repairing'
        ? visualState({ status: 'findings', findings: { issues: 1, undecided: 0, fixesOpen: 1, stage: 'fixing', exhausted: false }, branch })
        : visualState({ status: 'passed', blocksMerge: false, blocksCompletion: false, pendingVerification: false, progress: undefined, branch });

  const checks: MissionChecksSource = {
    branch: 'mission-branch',
    target: 'dev',
    mergeTier: variant === 'handoff-approval' ? 'human' : 'agent-review',
    visual,
    criteria: [{ type: 'command', command: 'bun run test', label: 'Unit tests pass' }],
    criteriaState: merged
      ? { evaluatedAt: new Date(base.now).toISOString(), evaluatedBy: 'auto', overall: 'pass', criteria: [{ index: 0, type: 'command', verdict: 'pass', evidence: 'Passed on dev.' }] }
      : null,
    integrationPr: { branch: 'mission/billing-exports', state: merged ? 'merged' : 'open', prNumber: 128, prUrl: '#mission-pr', taskId: null },
    release: variant === 'handoff-delivered' ? 'healthy' : variant === 'handoff-deploy-failed' ? 'failed' : merged ? 'deploying' : 'waiting',
    releaseLabel: 'Release v0.42.0',
  };
  const expectedMinutes = Object.fromEntries(tasks.slice(6, 10).map((t, i) => [t.id, [18, 9, 7, 5][i]]));
  return {
    model,
    executor: variant === 'handoff-local' ? 'local' : 'runner',
    checks,
    expectedMinutes,
    held: variant === 'handoff-budget',
  };
}
