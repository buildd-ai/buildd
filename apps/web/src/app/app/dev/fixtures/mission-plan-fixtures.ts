/**
 * `?state=mission-plan&variant=`: the Missions Plan page's four faces, which
 * the scrubbed CI data cannot produce (it only ever shows "estimates are off").
 *
 * - `ready` (default): finish dates, a release cut, a mission waiting on you
 *   and one waiting on another mission.
 * - `off`: the team has task estimates switched off.
 * - `empty`: estimates are on and no mission is open.
 * - `error`: the plan failed to load.
 *
 * Times are offsets from `now`, so the chart reads the same on any day.
 */
import type { PlanMissionInput, ReleasePlan } from '@/lib/mission-plan';
import { MISSION_PLAN_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_PLAN_STATE = MISSION_PLAN_FIXTURE_STATE;
export const MISSION_PLAN_VARIANTS = ['ready', 'off', 'empty', 'error'] as const;
export type MissionPlanVariant = (typeof MISSION_PLAN_VARIANTS)[number];

export function parseMissionPlanVariant(v: string | null | undefined): MissionPlanVariant {
  return (MISSION_PLAN_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionPlanVariant) : 'ready';
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WS = 'plan-fixture-workspace';

const task = (id: string, p: Partial<PlanMissionInput['tasks'][number]> = {}): PlanMissionInput['tasks'][number] => ({
  id, status: 'pending', dependsOn: [], startedAt: null, endedAt: null, p50Minutes: 240, p80Minutes: 420, ...p,
});

export function missionPlanFixtureData(now: number): { inputs: PlanMissionInput[]; plans: Map<string, ReleasePlan> } {
  const mission = (id: string, title: string, p: Partial<PlanMissionInput>): PlanMissionInput => ({
    id, title, href: `/app/missions/${id}`, workspaceId: WS, blocked: null, dependsOnMissionId: null, tasks: [task(`${id}-t`)], ...p,
  });
  const inputs: PlanMissionInput[] = [
    mission('plan-fx-a', 'Checkout redesign', {
      tasks: [
        task('a1', { status: 'completed', startedAt: now - 2 * DAY, endedAt: now - DAY }),
        task('a2', { status: 'running', startedAt: now - 3 * HOUR, p50Minutes: 360, p80Minutes: 600 }),
      ],
    }),
    mission('plan-fx-b', 'Search latency', { tasks: [task('b1', { startedAt: now - DAY, status: 'running', p50Minutes: 1200, p80Minutes: 2400 })] }),
    mission('plan-fx-c', 'Billing migration', { dependsOnMissionId: 'plan-fx-b', tasks: [task('c1', { p50Minutes: 900, p80Minutes: 1800 })] }),
    mission('plan-fx-d', 'Vendor review', { blocked: 'you' }),
  ];
  const plans = new Map<string, ReleasePlan>([[WS, { mode: 'cuts', cuts: [now + 2 * DAY, now + 9 * DAY], latestVersion: 'v1.4.2' }]]);
  return { inputs, plans };
}
