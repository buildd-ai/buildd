/**
 * The `?state=mission-strip-lanes` dev fixture: the compact-lanes EXPERIMENT
 * side by side with the production flat strip, on the same dependency shapes,
 * at all three densities (mission page, missions list, Home).
 *
 *   &layout=both    flat | lanes, side by side (default)
 *   &layout=flat    production only
 *   &layout=lanes   the experiment only
 *   &shape=<name>   one shape only
 *
 * Each shape is ONE set of rows: the mission page's model is built from them
 * with `buildMissionBoard`, and the list/Home model from the same rows (as the
 * list loads them) with `buildMissionListCard`, so the fixture shows — and the
 * parity test asserts — what the real pages would draw. Illustrative rows only.
 */
import type { BoardTaskInput, MissionBoardModel } from '@/lib/mission-board';
import { buildMissionCardView, summarizeMissionForCard } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow, type MissionListCardModel } from '@/lib/mission-list-card';
import { parseStripLayout, type StripLayout } from '@/lib/mission-task-strip';
import { dagBoard, dagTasks, type DagSpec } from './mission-task-strip-fixtures';
import { MISSION_STRIP_LANES_FIXTURE_STATE } from './visual-review-fixtures';

export { MISSION_STRIP_LANES_FIXTURE_STATE };

const letters = (s: string) => s.split('');

/** The shapes the experiment is judged on (task 797ba4fb). */
export const LANE_SHAPES = {
  linear: { caption: 'Linear A→B→C→D', spec: { tasks: letters('ABCD'), edges: { B: ['A'], C: ['B'], D: ['C'] }, states: { A: 'landed', B: 'running' } } },
  'fan-out': { caption: 'Fan-out A→{B,C}', spec: { tasks: letters('ABC'), edges: { B: ['A'], C: ['A'] }, states: { A: 'landed', B: 'running' } } },
  'fan-in': { caption: 'Fan-in {B,C}→D', spec: { tasks: letters('BCD'), edges: { D: ['B', 'C'] }, states: { B: 'landed', C: 'running' } } },
  diamond: { caption: 'Diamond A→{B,C}→D', spec: { tasks: letters('ABCD'), edges: { B: ['A'], C: ['A'], D: ['B', 'C'] }, states: { A: 'landed', B: 'review', C: 'running' } } },
  'two-chains': {
    caption: 'Two independent chains A→B→C, X→Y→Z',
    spec: { tasks: letters('AXBYCZ'), edges: { B: ['A'], C: ['B'], Y: ['X'], Z: ['Y'] }, states: { A: 'landed', X: 'landed', B: 'running' } },
  },
  deep: {
    caption: 'Deep chain of 10',
    spec: {
      tasks: letters('ABCDEFGHIJ'),
      edges: Object.fromEntries(letters('BCDEFGHIJ').map((t, i) => [t, ['ABCDEFGHIJ'[i]]])),
      states: { A: 'landed', B: 'landed', C: 'landed', D: 'running' },
    },
  },
  // The Home field repro: B was filed second but depends on C, filed later
  // and already in CI. Phase/creation order drew C after an empty B.
  field: {
    caption: 'Field: a dependent filed before its upstream, mixed states',
    spec: {
      tasks: letters('ABCDEFG'),
      edges: { B: ['C'], C: ['A'], D: ['B'], E: ['A'], F: ['D', 'E'], G: ['F'] },
      states: { A: 'landed', C: 'review', E: 'running', G: 'failed' },
    },
  },
} satisfies Record<string, { caption: string; spec: DagSpec }>;

export type LaneShape = keyof typeof LANE_SHAPES;
export const LANE_SHAPE_NAMES = Object.keys(LANE_SHAPES) as LaneShape[];

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW = T0 + 60 * 60_000;
const asDate = (ms: number | null | undefined) => (ms == null ? null : new Date(ms));

/** A board row as the list's query loads it (dates, not epochs). */
export function toListTaskRow(t: BoardTaskInput): ListTaskRow {
  return {
    id: t.id, title: t.title, label: t.label ?? null, status: t.status, createdAt: t.createdAt,
    taskClass: t.taskClass ?? null, mode: t.mode ?? null, roleSlug: t.roleSlug ?? null,
    dependsOn: t.dependsOn ? [...t.dependsOn] : null, missionPhaseIndex: t.missionPhaseIndex ?? null, missionPhaseLabel: t.missionPhaseLabel ?? null,
    workers: t.workers.map(w => ({
      id: w.id, status: w.status, startedAt: asDate(w.startedAt), completedAt: asDate(w.completedAt), updatedAt: asDate(w.updatedAt),
      prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: asDate(w.mergedAt),
    })),
  };
}

export interface LaneShapeFixture {
  name: LaneShape;
  caption: string;
  /** The mission page's model. */
  board: MissionBoardModel;
  /** The missions list's and Home's model (one model, two densities). */
  list: MissionListCardModel;
}

export function laneShapeFixture(name: LaneShape, now = NOW): LaneShapeFixture {
  const { caption, spec } = LANE_SHAPES[name];
  const row: ListMissionRow = {
    id: `fx-lanes-${name}`, title: caption, status: 'active', executor: 'runner', workspaceId: 'fx-ws',
    createdAt: new Date(T0), tasks: dagTasks(spec).map(toListTaskRow),
  };
  const summary = summarizeMissionForCard(row, { now });
  const view = buildMissionCardView(row, { from: 'missions', now, summary });
  return { name, caption, board: dagBoard(spec, { now }), list: buildMissionListCard(row, view, summary, { now }) };
}

export interface LanesFixtureParams {
  layouts: StripLayout[];
  shapes: LaneShape[];
}

export function parseLanesFixtureParams(q: URLSearchParams): LanesFixtureParams {
  const layout = q.get('layout');
  const shape = q.get('shape');
  return {
    layouts: layout === 'flat' || layout === 'lanes' ? [parseStripLayout(layout)] : ['flat', 'lanes'],
    shapes: shape && shape in LANE_SHAPES ? [shape as LaneShape] : LANE_SHAPE_NAMES,
  };
}

export function laneFixtureLinks(): { label: string; href: string }[] {
  const base = `?state=${MISSION_STRIP_LANES_FIXTURE_STATE}`;
  return [
    { label: 'both', href: base },
    { label: 'flat', href: `${base}&layout=flat` },
    { label: 'lanes', href: `${base}&layout=lanes` },
    ...LANE_SHAPE_NAMES.map(s => ({ label: s, href: `${base}&shape=${s}` })),
  ];
}
