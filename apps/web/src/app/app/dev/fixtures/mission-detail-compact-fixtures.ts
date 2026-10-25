/**
 * The `?state=mission-detail-compact` dev fixture: the real mission detail
 * header (back, title, state, Verified, clock, the ⋯ menu, goal, spec line)
 * over the real Overview, at the density a phone actually meets.
 *
 *   &variant=building     Navigation AC-4: 16 tasks, 11 merged, 1 running, 1 fixing,
 *                         1 needing a decision (the card on top), 1 waiting on it, 1 queued
 *   &variant=eleven       11 tasks: 01-03 landed, 04-08 not started, 09-11 building
 *   &variant=long-title   the same mission under a title far past one line
 *   &variant=no-tasks     planned, nothing created yet
 *   &variant=all-landed   every task landed, the mission complete
 *   &variant=verify       the build done: `10 tasks merged ›` and the checks (AC-9)
 *   &variant=delivered    merged and released: `Delivered into dev` with the requirements folded (AC-9)
 *   &select=04|09         open on that strip position (tick), the way a tap would
 *
 * Illustrative rows only (made-up ids and titles) through the real
 * `buildMissionBoard`, so the bar, the list and the cards read what the page reads.
 */
import { optionOutcomes, type QuestionWaits } from '@buildd/core/question-waits';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel } from '@/lib/mission-board';
import type { TaskDeliveryDetail } from '@/lib/activity-delivery';
import type { MissionChecksSource } from '@/app/app/(protected)/missions/[id]/MissionOverview';
import type { PlanTask } from '@/lib/mission-plan';
import { historyRaised, missionDecisions, type HistoryRaised } from '@/lib/mission-decisions';
import type { DecisionView } from '@/lib/needs-you-card';
import { dagTasks, handoffFixture, stripFixtureId, type DagSpec } from './mission-task-strip-fixtures';
import { MISSION_DETAIL_COMPACT_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_DETAIL_COMPACT_STATE = MISSION_DETAIL_COMPACT_FIXTURE_STATE;
export const MISSION_DETAIL_COMPACT_VARIANTS = ['building', 'eleven', 'long-title', 'no-tasks', 'all-landed', 'verify', 'delivered'] as const;
export type MissionDetailCompactVariant = (typeof MISSION_DETAIL_COMPACT_VARIANTS)[number];

export const COMPACT_TITLE = 'Billing exports: readable schedules, clear retention and enforceable limits';
export const COMPACT_LONG_TITLE =
  'Billing exports: readable schedules, clear retention, enforceable per-workspace limits and a calm phone layout for every export state we already ship';
export const COMPACT_GOAL =
  'Make every billing export explain when it runs, what it keeps and which limit stops it, on a phone as well as a desk.';
/** The AC-4 mission's title and goal (design 6356e80d, #desktop-mission). */
export const BUILDING_TITLE = 'One-click cloud runner deploy from Settings';
export const BUILDING_GOAL = 'A person with a verified Cloudflare token deploys the cloud runner from Settings with one button.';
export const BUILDING_SPEC_ID = stripFixtureId(960);
export const BUILDING_SPEC_TITLE = 'Cloud runner: deploy from Settings';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** The board's criteria; the header's Verified pill gets the same three. */
export const CRITERIA = [
  { type: 'all_prs_merged', label: 'All PRs merged' },
  { type: 'no_open_tasks', label: 'No open tasks' },
  { type: 'command', label: 'Unit tests pass' },
];

/** 01-03 landed; 04 ready; 05-08 wait on 04 and each other; 09-11 building off 03. */
export const ELEVEN: DagSpec = {
  tasks: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'],
  edges: { '02': ['01'], '03': ['02'], '05': ['04'], '06': ['05'], '07': ['05'], '08': ['06', '07'], '09': ['03'], '10': ['03'], '11': ['03'] },
  states: { '01': 'landed', '02': 'landed', '03': 'landed', '09': 'running', '10': 'running', '11': 'running' },
};

const TITLES: Record<string, string> = {
  '01': 'feat(billing): export schedule model',
  '02': 'feat(billing): retention policy per export',
  '03': 'feat(billing): limits table and enforcement hook',
  '04': 'feat(billing): explain the next run in plain words',
  '05': 'feat(billing): retention copy on the export sheet',
  '06': 'feat(billing): limit reached banner',
  '07': 'feat(billing): admin override for one workspace',
  '08': 'test(billing): end-to-end export with a limit',
  '09': 'feat(billing): settings page for schedules',
  '10': 'feat(billing): CSV header options',
  '11': 'docs(billing): export limits guide',
};

export interface MissionDetailCompactFixture {
  variant: MissionDetailCompactVariant;
  title: string;
  goal: string;
  model: MissionBoardModel;
  deliveries: Record<string, TaskDeliveryDetail>;
  /** The strip position to open on, 0-based (`&select=04` → 3), or null for the default. */
  selectIndex: number | null;
  /** The checks after the build, when the variant has them (the stage line, Verify, Deliver). */
  checks: MissionChecksSource | null;
  planTasks: PlanTask[] | null;
  specTitles: Record<string, string>;
  /** The decision cards (Navigation R-16) and the raised History line (R-6). */
  decisions: DecisionView[];
  history: HistoryRaised | null;
  /** Task id → expected minutes, for the summary's `finish depends on` (Navigation R-22). */
  expectedMinutes: Record<string, number> | null;
}

export function parseMissionDetailCompact(q: URLSearchParams): { variant: MissionDetailCompactVariant; select: string | null } {
  const v = q.get('variant');
  const variant = (MISSION_DETAIL_COMPACT_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionDetailCompactVariant) : 'building';
  const s = q.get('select');
  return { variant, select: s && /^\d\d$/.test(s) && +s >= 1 && +s <= ELEVEN.tasks.length ? s : null };
}

export function missionDetailCompactLinks(): { label: string; href: string }[] {
  const base = `?state=${MISSION_DETAIL_COMPACT_STATE}`;
  return [
    { label: 'building (AC-4)', href: `${base}&variant=building` },
    { label: '11 tasks · 04', href: `${base}&variant=eleven&select=04` },
    { label: '11 tasks · 09', href: `${base}&variant=eleven&select=09` },
    { label: 'long title', href: `${base}&variant=long-title&select=04` },
    { label: 'no tasks', href: `${base}&variant=no-tasks` },
    { label: 'all landed', href: `${base}&variant=all-landed` },
    { label: 'verify', href: `${base}&variant=verify` },
    { label: 'delivered', href: `${base}&variant=delivered` },
    { label: 'design', href: `${base}&variant=building&design=1` },
    { label: 'design unavailable', href: `${base}&variant=building&design=unavailable` },
  ];
}

function building(prNumber: number | null): TaskDeliveryDetail {
  return {
    kind: 'build', repairRounds: 0, prNumber, revisions: 0, repairs: 0, evidence: [],
    stages: { build: 'Agent building', audit: 'After Build', land: 'After Verify' },
  };
}

function merged(prNumber: number): TaskDeliveryDetail {
  return {
    kind: 'landed', repairRounds: 0, prNumber, revisions: 1, repairs: 0, evidence: [],
    stages: { build: `PR #${prNumber} opened`, audit: 'Review approved · CI green', land: 'Merged' },
  };
}

/**
 * The strip fixtures date their rows from a fixed epoch; the header clock
 * ticks from the real now. Move every row so the mission opened an hour
 * before `now` and the clock reads T+ 1:00, not months.
 */
function shifted(t: BoardTaskInput, delta: number): BoardTaskInput {
  const at = (v: number | null | undefined) => (v == null ? v ?? null : v + delta);
  const workers = (t.workers ?? []).map(w => ({ ...w, startedAt: at(w.startedAt), completedAt: at(w.completedAt), updatedAt: at(w.updatedAt), mergedAt: at(w.mergedAt) }));
  const w = t.worker;
  const date = (d: Date | string | null | undefined) => (d ? new Date(new Date(d).getTime() + delta) : null);
  return {
    ...t,
    createdAt: date(t.createdAt)!,
    workers,
    worker: w ? { ...w, startedAt: date(w.startedAt), updatedAt: date(w.updatedAt), mergedAt: date(w.mergedAt) } : null,
  };
}

// ── The AC-4 mission (design #desktop-mission, #phone-mission) ──────────────

function worker(id: string, over: Partial<BoardWorkerInput>): BoardWorkerInput {
  return {
    id, status: 'completed', runner: 'alpha', startedAt: T0, completedAt: T0, updatedAt: T0,
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}

function row(n: number, title: string, createdAt: number, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  const workers = over.workers ?? [];
  const first = workers[0];
  return {
    id: stripFixtureId(n), title, status: 'pending', taskClass: 'work', createdAt: new Date(createdAt + n * 1000),
    missionPhaseIndex: 1, missionPhaseLabel: 'Build', roleSlug: 'builder', outputRequirement: 'pr_required', backend: 'claude', workers,
    worker: first ? {
      status: first.status, startedAt: first.startedAt ? new Date(first.startedAt) : null,
      updatedAt: first.updatedAt ? new Date(first.updatedAt) : null, prNumber: first.prNumber,
      prUrl: first.prUrl, prLifecycleStatus: first.prLifecycleStatus, mergedAt: first.mergedAt ? new Date(first.mergedAt) : null,
    } : null,
    ...over,
  };
}

const BUILDING_MERGED = [
  'Cloudflare token: verify once, store as a team secret', 'Settings: the Deploy runner button', 'Deploy: create the worker and its KV',
  'Deploy: bind the dispatch token', 'Deploy: first health check', 'Runner image: publish to GitHub registry', 'Runner image: pin by digest',
  'Settings: deploy log, one line per step', 'Deploy: retry a failed step once', 'Docs: deploying a cloud runner', 'Settings: remove a deployed runner',
];
export const BUILDING_DECISION_TASK = stripFixtureId(12);

/** 16 build tasks: 11 merged, 1 asking, 1 running, 1 fixing (resumes later), 1 waiting on the ask, 1 queued. */
function buildingRows(now: number): BoardTaskInput[] {
  const opened = now - 3 * 3_600_000;
  const min = (n: number) => opened + n * 60_000;
  const rows: BoardTaskInput[] = BUILDING_MERGED.map((title, i) => {
    const n = i + 1;
    const pr = 5400 + n;
    return row(n, title, opened, {
      status: 'completed',
      workers: [worker(`w${n}`, { startedAt: min(n * 8), completedAt: min(n * 8 + 6), updatedAt: min(n * 8 + 6), mergedAt: min(n * 8 + 7), prNumber: pr, prUrl: `https://github.com/example/app/pull/${pr}`, prLifecycleStatus: 'merged' })],
    });
  });
  rows.push(row(12, 'Mirror the runner image to Docker Hub', opened, {
    status: 'in_progress',
    workers: [worker('w12', {
      status: 'waiting_input', startedAt: now - 14 * 60_000, completedAt: null, updatedAt: now - 60_000,
      waitingFor: {
        prompt: 'How should Docker Hub credentials be set up?',
        options: ['Provide a token', "I'll set them myself"],
        full: {
          type: 'question', prompt: 'How should Docker Hub credentials be set up?',
          context: "Cloudflare can't pull from GitHub's registry, and CI has no Docker Hub secrets, so every release skips the image mirror",
          options: [
            { label: 'Provide a token', consequence: 'Stored as a team secret, revocable', description: 'Recommended by the agent. You paste a Docker Hub access token next; buildd stores it as a team secret scoped to this repo, never in the repo or logs. The agent adds the CI secrets, reruns the release and continues both waiting tasks.', recommended: true },
            { label: "I'll set them myself", consequence: 'Resumes when CI sees them', description: 'You add DOCKERHUB_USERNAME and DOCKERHUB_TOKEN to the repo secrets in GitHub. Both waiting tasks start again by themselves on the next CI run that sees them.' },
          ],
        },
      },
    })],
  }));
  rows.push(row(13, 'Redeploy keeps the dispatch token', opened, {
    status: 'in_progress',
    workers: [worker('w13', {
      status: 'running', startedAt: now - 12 * 60_000, completedAt: null, updatedAt: now - 14_000, currentAction: 'Writing the redeploy test',
      milestones: [{ ts: now - 9 * 60_000, label: 'Reproduced: redeploy drops the token' }, { ts: now - 4 * 60_000, label: 'Kept DISPATCH_TOKEN when the worker is recreated' }, { ts: now - 14_000, label: 'Writing the redeploy test' }],
    })],
  }));
  rows.push(row(14, 'Settings shows each deploy step', opened, {
    status: 'pending', startAt: now + 232 * 60_000,
    workers: [worker('w14', { startedAt: min(100), completedAt: min(110), updatedAt: min(110), prNumber: 5420, prUrl: 'https://github.com/example/app/pull/5420', prLifecycleStatus: 'ci_failed' })],
  }));
  rows.push(row(15, 'The release publishes an image digest', opened, { dependsOn: [BUILDING_DECISION_TASK] }));
  rows.push(row(16, 'A runner bundle on every release', opened - 2 * 3_600_000, {}));
  return rows;
}

const MISSION_ID = stripFixtureId(950);

/**
 * What the projection (lib/question-waits.ts) returns for the building
 * mission's open decision: the release task waits on it, the question
 * expires four hours after it was asked. Literal fixture data, as the
 * projection would return it; the card never derives it.
 */
function buildingDecisionWaits(now: number): QuestionWaits {
  const base: QuestionWaits = {
    taskId: BUILDING_DECISION_TASK, mission: { id: MISSION_ID, title: BUILDING_TITLE }, hiddenCount: 0, beyondCount: 0, lanes: [], criteria: null,
    waiting: [{ id: stripFixtureId(15), title: 'The release publishes an image digest', depth: 1, missionId: MISSION_ID, missionTitle: BUILDING_TITLE, workspaceName: null, after: null, alsoWaitsOnOther: false }],
    askedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 60_000 + 4 * 3_600_000).toISOString(),
    onExpiry: { action: 'default', option: 'Provide a token' }, options: [],
  };
  return { ...base, options: optionOutcomes([{ label: 'Provide a token', outcome: 'finishes', recommended: true }, { label: "I'll set them myself", outcome: 'continues' }], base) };
}

export function missionDetailCompactFixture(variant: MissionDetailCompactVariant, select: string | null, now = T0 + 60 * 60_000): MissionDetailCompactFixture {
  const opened = now - 60 * 60_000;
  const base = { now, missionCreatedAt: opened };
  const empty = { deliveries: {}, selectIndex: null, checks: null, planTasks: null, specTitles: {}, decisions: [], history: null, expectedMinutes: null };
  const hrefFor = (taskId: string) => `/app/tasks/${taskId}?from=mission&missionId=${MISSION_ID}`;
  const mission = { id: MISSION_ID, title: BUILDING_TITLE, href: `/app/missions/${MISSION_ID}` };

  if (variant === 'building') {
    const model = buildMissionBoard({ ...base, missionCreatedAt: now - 3 * 3_600_000, missionStatus: 'active', tasks: buildingRows(now) });
    const checks: MissionChecksSource = {
      branch: 'direct', target: 'dev', mergeTier: 'agent-review', visual: null,
      criteria: [{ type: 'living_spec', specId: BUILDING_SPEC_ID, specRevisionId: stripFixtureId(961), revision: 5, contentHash: 'fixture' } as MissionChecksSource['criteria'][number]],
      criteriaState: null, integrationPr: null, release: 'not_configured',
    };
    return {
      ...empty, variant, title: BUILDING_TITLE, goal: BUILDING_GOAL, model, checks,
      specTitles: { [BUILDING_SPEC_ID]: BUILDING_SPEC_TITLE },
      decisions: missionDecisions({ model, notes: [], mission, hrefFor, waitsByTask: new Map([[BUILDING_DECISION_TASK, buildingDecisionWaits(now)]]) }),
      history: historyRaised(model, []),
      // Every unmerged task estimated, so the summary names what sets the finish (AC-18).
      expectedMinutes: { [stripFixtureId(12)]: 40, [stripFixtureId(13)]: 30, [stripFixtureId(14)]: 25, [stripFixtureId(15)]: 35, [stripFixtureId(16)]: 20 },
    };
  }
  if (variant === 'verify' || variant === 'delivered') {
    const f = handoffFixture(variant === 'verify' ? 'handoff-verifying' : 'handoff-delivered', { ...base, missionStatus: 'active' });
    return { ...empty, variant, title: BUILDING_TITLE, goal: BUILDING_GOAL, model: f.model, checks: f.checks ?? null, planTasks: f.planTasks ?? null };
  }

  const title = variant === 'long-title' ? COMPACT_LONG_TITLE : COMPACT_TITLE;
  if (variant === 'no-tasks') {
    return { ...empty, variant, title, goal: COMPACT_GOAL, model: buildMissionBoard({ ...base, missionStatus: 'active', tasks: [], criteria: CRITERIA }) };
  }
  const allLanded = variant === 'all-landed';
  const spec: DagSpec = allLanded
    ? { ...ELEVEN, states: Object.fromEntries(ELEVEN.tasks.map(n => [n, 'landed' as const])) }
    : ELEVEN;
  const tasks = dagTasks(spec).map((t, i) => shifted({ ...t, title: TITLES[ELEVEN.tasks[i]] }, opened - T0));
  const model = buildMissionBoard({
    ...base,
    tasks,
    criteria: CRITERIA,
    ...(allLanded ? { criteriaState: CRITERIA.map((_, index) => ({ index, verdict: 'pass' })) } : {}),
    missionStatus: allLanded ? 'completed' : 'active',
    ...(allLanded ? { missionCompletedAt: now - 5 * 60_000 } : {}),
  });
  const deliveries: Record<string, TaskDeliveryDetail> = {};
  ELEVEN.tasks.forEach((n, i) => {
    const state = spec.states?.[n];
    if (state === 'landed') deliveries[stripFixtureId(i + 1)] = merged(401 + i);
    if (state === 'running') deliveries[stripFixtureId(i + 1)] = building(null);
  });
  return { ...empty, variant, title, goal: COMPACT_GOAL, model, deliveries, selectIndex: select ? +select - 1 : null };
}
