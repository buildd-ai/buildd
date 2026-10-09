/**
 * The `?state=mission-detail-compact` dev fixture: the real mission detail
 * header (back, title, state, Verified, clock, tabs, actions, goal) over the
 * real Overview, at the density a phone actually meets.
 *
 *   &variant=eleven       11 tasks: 01-03 landed, 04-08 not started, 09-11 building
 *   &variant=long-title   the same mission under a title far past one line
 *   &variant=no-tasks     planned, nothing created yet
 *   &variant=all-landed   every task landed, the mission complete
 *   &select=04|09         open on that strip cell, the way a tap would
 *
 * Illustrative rows only (made-up ids and titles) through the real
 * `buildMissionBoard`, so the strip and focus card read what the page reads.
 */
import { buildMissionBoard, type MissionBoardModel } from '@/lib/mission-board';
import type { TaskDeliveryDetail } from '@/lib/activity-delivery';
import { dagId, dagTasks, stripFixtureId, type DagSpec } from './mission-task-strip-fixtures';
import { MISSION_DETAIL_COMPACT_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_DETAIL_COMPACT_STATE = MISSION_DETAIL_COMPACT_FIXTURE_STATE;
export const MISSION_DETAIL_COMPACT_VARIANTS = ['eleven', 'long-title', 'no-tasks', 'all-landed'] as const;
export type MissionDetailCompactVariant = (typeof MISSION_DETAIL_COMPACT_VARIANTS)[number];

export const COMPACT_TITLE = 'Billing exports: readable schedules, clear retention and enforceable limits';
export const COMPACT_LONG_TITLE =
  'Billing exports: readable schedules, clear retention, enforceable per-workspace limits and a calm phone layout for every export state we already ship';
export const COMPACT_GOAL =
  'Make every billing export explain when it runs, what it keeps and which limit stops it, on a phone as well as a desk.';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

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
  model: MissionBoardModel;
  deliveries: Record<string, TaskDeliveryDetail>;
  /** The strip cell to open on (`&select=`), or null for the default. */
  selectId: string | null;
}

export function parseMissionDetailCompact(q: URLSearchParams): { variant: MissionDetailCompactVariant; select: string | null } {
  const v = q.get('variant');
  const variant = (MISSION_DETAIL_COMPACT_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionDetailCompactVariant) : 'eleven';
  const s = q.get('select');
  return { variant, select: s && ELEVEN.tasks.includes(s) ? s : null };
}

export function missionDetailCompactLinks(): { label: string; href: string }[] {
  const base = `?state=${MISSION_DETAIL_COMPACT_STATE}`;
  return [
    { label: '11 tasks · 04', href: `${base}&variant=eleven&select=04` },
    { label: '11 tasks · 09', href: `${base}&variant=eleven&select=09` },
    { label: 'long title', href: `${base}&variant=long-title&select=04` },
    { label: 'no tasks', href: `${base}&variant=no-tasks` },
    { label: 'all landed', href: `${base}&variant=all-landed` },
  ];
}

function building(prNumber: number | null): TaskDeliveryDetail {
  return {
    kind: 'build', repairRounds: 0, prNumber, revisions: 0, repairs: 0, evidence: [],
    stages: { build: 'Agent building', audit: 'After Build', land: 'After Audit' },
  };
}

function merged(prNumber: number): TaskDeliveryDetail {
  return {
    kind: 'landed', repairRounds: 0, prNumber, revisions: 1, repairs: 0, evidence: [],
    stages: { build: `PR #${prNumber} opened`, audit: 'Review approved · CI green', land: 'Merged' },
  };
}

export function missionDetailCompactFixture(variant: MissionDetailCompactVariant, select: string | null, now = T0 + 60 * 60_000): MissionDetailCompactFixture {
  const title = variant === 'long-title' ? COMPACT_LONG_TITLE : COMPACT_TITLE;
  const base = { now, missionCreatedAt: T0 };
  if (variant === 'no-tasks') {
    return { variant, title, model: buildMissionBoard({ ...base, missionStatus: 'active', tasks: [] }), deliveries: {}, selectId: null };
  }
  const allLanded = variant === 'all-landed';
  const spec: DagSpec = allLanded
    ? { ...ELEVEN, states: Object.fromEntries(ELEVEN.tasks.map(n => [n, 'landed' as const])) }
    : ELEVEN;
  const tasks = dagTasks(spec).map((t, i) => ({ ...t, title: TITLES[ELEVEN.tasks[i]] }));
  const model = buildMissionBoard({
    ...base,
    tasks,
    missionStatus: allLanded ? 'completed' : 'active',
    ...(allLanded ? { missionCompletedAt: now - 5 * 60_000 } : {}),
  });
  const deliveries: Record<string, TaskDeliveryDetail> = {};
  ELEVEN.tasks.forEach((n, i) => {
    const state = spec.states?.[n];
    if (state === 'landed') deliveries[stripFixtureId(i + 1)] = merged(401 + i);
    if (state === 'running') deliveries[stripFixtureId(i + 1)] = building(null);
  });
  return { variant, title, model, deliveries, selectId: select ? dagId(ELEVEN, select) : null };
}
