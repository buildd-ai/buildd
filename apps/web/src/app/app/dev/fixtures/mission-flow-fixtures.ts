/**
 * The `?state=mission-flow` dev fixture and the Flow timeline tests' missions:
 * the refined-UI prototype's two Flow fixtures, built through the real
 * `buildMissionBoard` so the timeline reads exactly what the mission page reads.
 *
 *   &m=small   7 tasks: a fork (02 → 03, 04) and a join (03 + 04 → 06)
 *   &m=wide    13 tasks: a 6-wide level, two joins, a chain, and a same-files
 *              wait Buildd added (10 waits on 05)
 *   &sel=N     open on fixture task N
 *
 * Illustrative rows only: made-up ids, titles and times.
 */
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel } from '@/lib/mission-board';
import { stripFixtureId } from './mission-task-strip-fixtures';
import { MISSION_FLOW_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_FLOW_STATE = MISSION_FLOW_FIXTURE_STATE;
export const MISSION_FLOW_VARIANTS = ['small', 'wide'] as const;
export type MissionFlowVariant = (typeof MISSION_FLOW_VARIANTS)[number];

export function parseMissionFlowVariant(q: URLSearchParams): MissionFlowVariant {
  const v = q.get('m');
  return (MISSION_FLOW_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionFlowVariant) : 'small';
}

export function missionFlowLinks(): { label: string; href: string }[] {
  return MISSION_FLOW_VARIANTS.map(v => ({ label: `flow: ${v}`, href: `?state=${MISSION_FLOW_STATE}&m=${v}` }));
}

export interface MissionFlowFixture {
  model: MissionBoardModel;
  sameFiles: Record<string, string[]>;
  expectedMinutes: Record<string, number>;
  /** Fixture number (`01`…) → task id. */
  idOf: (n: number) => string;
}

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const id = (n: number) => stripFixtureId(700 + n);

type Shape =
  | { kind: 'landed'; start: number; done: number; merged: number }
  | { kind: 'review'; start: number; done: number }
  | { kind: 'ci_failed'; start: number; done: number }
  | { kind: 'running'; start: number }
  | { kind: 'pending' };

interface Row { n: number; title: string; deps?: number[]; minutes: number; shape: Shape; }

function worker(n: number, over: Partial<BoardWorkerInput>): BoardWorkerInput {
  return {
    id: `wf${n}`, status: 'completed', runner: 'alpha', startedAt: null, completedAt: null, updatedAt: null,
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}

function toInput(r: Row, at: (m: number) => number, t0: number): BoardTaskInput {
  const pr = 500 + r.n;
  const prOf = { prNumber: pr, prUrl: `https://github.com/example/app/pull/${pr}` };
  const s = r.shape;
  const workers: BoardWorkerInput[] =
    s.kind === 'landed' ? [worker(r.n, { startedAt: at(s.start), completedAt: at(s.done), updatedAt: at(s.merged), mergedAt: at(s.merged), ...prOf, prLifecycleStatus: 'merged' })]
    : s.kind === 'review' ? [worker(r.n, { startedAt: at(s.start), completedAt: at(s.done), updatedAt: at(s.done), ...prOf, prLifecycleStatus: 'ci_green' })]
    : s.kind === 'ci_failed' ? [worker(r.n, { startedAt: at(s.start), completedAt: at(s.done), updatedAt: at(s.done), ...prOf, prLifecycleStatus: 'ci_failed' })]
    : s.kind === 'running' ? [worker(r.n, { status: 'running', startedAt: at(s.start), updatedAt: at(s.start), currentAction: 'Editing files' })]
    : [];
  const w = workers[0];
  return {
    id: id(r.n), title: r.title, status: s.kind === 'pending' ? 'pending' : s.kind === 'running' ? 'in_progress' : 'completed',
    taskClass: 'work', createdAt: new Date(t0 + r.n * 1000), missionPhaseIndex: 1, missionPhaseLabel: 'Build it',
    roleSlug: 'builder', outputRequirement: 'pr_required', backend: 'claude',
    dependsOn: r.deps?.length ? r.deps.map(id) : null,
    workers,
    worker: w ? {
      status: w.status, startedAt: w.startedAt ? new Date(w.startedAt) : null, updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
      prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: w.mergedAt ? new Date(w.mergedAt) : null,
    } : null,
  };
}

const SMALL: Row[] = [
  { n: 1, title: 'Delivery spec', minutes: 20, shape: { kind: 'landed', start: 0, done: 22, merged: 30 } },
  { n: 2, title: 'Prototype and feasibility', deps: [1], minutes: 45, shape: { kind: 'landed', start: 32, done: 127, merged: 130 } },
  { n: 3, title: 'Shared delivery projection', deps: [2], minutes: 40, shape: { kind: 'review', start: 132, done: 170 } },
  { n: 4, title: 'Missions portfolio list', deps: [2], minutes: 60, shape: { kind: 'running', start: 162 } },
  { n: 5, title: 'Activity now and history', deps: [3], minutes: 50, shape: { kind: 'pending' } },
  { n: 6, title: 'Mission detail: gates and repair', deps: [3, 4], minutes: 70, shape: { kind: 'pending' } },
  { n: 7, title: 'Final audit at 360, 390 and desktop', deps: [5, 6], minutes: 30, shape: { kind: 'pending' } },
];

const WIDE: Row[] = [
  { n: 1, title: 'Metering spec', minutes: 25, shape: { kind: 'landed', start: 0, done: 30, merged: 40 } },
  { n: 2, title: 'Usage events schema', deps: [1], minutes: 50, shape: { kind: 'landed', start: 40, done: 95, merged: 105 } },
  { n: 3, title: 'Metering API routes', deps: [2], minutes: 60, shape: { kind: 'review', start: 105, done: 200 } },
  { n: 4, title: 'Runner usage client', deps: [2], minutes: 70, shape: { kind: 'running', start: 200 } },
  { n: 5, title: 'Usage dashboard', deps: [2], minutes: 80, shape: { kind: 'running', start: 145 } },
  { n: 6, title: 'Mobile usage list', deps: [2], minutes: 40, shape: { kind: 'landed', start: 105, done: 140, merged: 150 } },
  { n: 7, title: 'Billing docs', deps: [2], minutes: 30, shape: { kind: 'pending' } },
  { n: 8, title: 'Invoice test harness', deps: [2], minutes: 50, shape: { kind: 'ci_failed', start: 110, done: 190 } },
  { n: 9, title: 'Invoice generator', deps: [3, 4], minutes: 90, shape: { kind: 'pending' } },
  { n: 10, title: 'Usage page polish', deps: [6], minutes: 35, shape: { kind: 'pending' } },
  { n: 11, title: 'Stripe sync', deps: [9], minutes: 50, shape: { kind: 'pending' } },
  { n: 12, title: 'Dunning emails', deps: [11], minutes: 40, shape: { kind: 'pending' } },
  { n: 13, title: 'Final audit at 360, 390 and desktop', deps: [7, 8, 10, 12], minutes: 30, shape: { kind: 'pending' } },
];

const FIXTURES: Record<MissionFlowVariant, { rows: Row[]; now: number; sameFiles: Array<[number, number]> }> = {
  small: { rows: SMALL, now: 180, sameFiles: [] },
  // 10 waits on 05: both change the usage page.
  wide: { rows: WIDE, now: 240, sameFiles: [[10, 5]] },
};

/** `now` moves the whole mission so its clock reads `now` (the dev page passes the real one). */
export function missionFlowFixture(variant: MissionFlowVariant, now?: number): MissionFlowFixture {
  const f = FIXTURES[variant];
  const t0 = now != null ? now - f.now * 60_000 : T0;
  const at = (m: number) => t0 + m * 60_000;
  const model = buildMissionBoard({ now: at(f.now), missionCreatedAt: t0, missionStatus: 'active', tasks: f.rows.map(r => toInput(r, at, t0)) });
  const sameFiles: Record<string, string[]> = {};
  for (const [to, from] of f.sameFiles) (sameFiles[id(to)] ??= []).push(id(from));
  return { model, sameFiles, expectedMinutes: Object.fromEntries(f.rows.map(r => [id(r.n), r.minutes])), idOf: id };
}
