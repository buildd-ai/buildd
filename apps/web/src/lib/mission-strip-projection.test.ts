/**
 * One dependency-first order: the mission page (`buildBoardCells` →
 * `stripOrder`), the missions list / Home / initiative card
 * (`buildMissionListCard`) and the masthead pulse (`buildPulseSegments`) draw
 * the same task ids in the same order. Fixtures go through the real builders.
 */
import { describe, expect, it } from 'bun:test';
import { dagBoard, dagId, dagTasks, DAG_SPECS, type DagSpec } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import type { BoardTaskInput } from './mission-board';
import { buildMissionCardView, summarizeMissionForCard } from './mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow, type MissionListCardModel } from './mission-list-card';
import { buildPulseSegments } from './mission-pulse';
import { feedStripOrder } from './mission-strip-order';
import { stripOrder } from './mission-task-strip';

const NOW = Date.UTC(2026, 0, 1, 13, 0, 0);
const asDate = (ms: number | null | undefined) => (ms == null ? null : new Date(ms));

const tokenOf = (spec: DagSpec) => {
  const byId = new Map(spec.tasks.map(t => [dagId(spec, t), t]));
  return (id: string) => byId.get(id) ?? id;
};

/** A board row as the list's query loads it (dates, not epochs). */
function toListTaskRow(t: BoardTaskInput): ListTaskRow {
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

const listCells = (m: MissionListCardModel) => m.phases.flatMap(p => p.cells);

function listCard(tasks: ListTaskRow[], opts: Parameters<typeof buildMissionListCard>[3] = {}) {
  const row: ListMissionRow = { id: 'fx-m', title: 'Example', status: 'active', executor: 'runner', createdAt: new Date(NOW - 3_600_000), tasks };
  const summary = summarizeMissionForCard(row, { now: NOW });
  const view = buildMissionCardView(row, { from: 'missions', now: NOW, summary });
  return { view, model: buildMissionListCard(row, view, summary, { now: NOW, ...opts }) };
}

const SHAPES: Record<string, DagSpec> = {
  ...DAG_SPECS,
  diamond: { tasks: ['A', 'B', 'C', 'D'], edges: { B: ['A'], C: ['A'], D: ['B', 'C'] }, states: { A: 'landed', B: 'review', C: 'running' } },
  'two-chains': { tasks: [...'AXBYCZ'], edges: { B: ['A'], C: ['B'], Y: ['X'], Z: ['Y'] }, states: { A: 'landed', X: 'landed', B: 'running' } },
  // Filed out of dependency order: the Home field repro, widened.
  reversed: { tasks: [...'ABCDEFG'], edges: { B: ['C'], C: ['A'], D: ['B'], E: ['A'], F: ['D', 'E'], G: ['F'] }, states: { A: 'landed', C: 'review', E: 'running', G: 'failed' } },
};

describe('detail, missions list, Home and pulse draw one order', () => {
  for (const [name, spec] of Object.entries(SHAPES)) {
    it(`${name}: same ids, same order`, () => {
      const detail = stripOrder(dagBoard(spec));
      const tasks = dagTasks(spec);
      const { model } = listCard(tasks.map(toListTaskRow));
      // The list card and Home's row read the same model (`model.phases`).
      expect(listCells(model).map(c => c.taskId)).toEqual(detail);
      expect(feedStripOrder(tasks)).toEqual(detail);
    });

    it(`${name}: every dependency is left of its dependent`, () => {
      const at = new Map(listCells(listCard(dagTasks(spec).map(toListTaskRow)).model).map((c, i) => [c.taskId, i]));
      for (const [t, deps] of Object.entries(spec.edges ?? {})) {
        for (const d of deps) expect(at.get(dagId(spec, d))!).toBeLessThan(at.get(dagId(spec, t))!);
      }
    });
  }
});

describe('Home field repro: a dependent filed before its upstream', () => {
  // B was filed second but depends on C, filed third and already in CI.
  const spec: DagSpec = { tasks: ['A', 'B', 'C', 'D'], edges: { B: ['C'], C: ['A'], D: ['B'] }, states: { A: 'landed', C: 'review' } };
  const tok = tokenOf(spec);

  it('the in-CI upstream draws before its empty dependent, on every surface', () => {
    const tasks = dagTasks(spec);
    const { model } = listCard(tasks.map(toListTaskRow));
    expect(stripOrder(dagBoard(spec)).map(tok)).toEqual(['A', 'C', 'B', 'D']);
    expect(listCells(model).map(c => tok(c.taskId))).toEqual(['A', 'C', 'B', 'D']);
    // C has a green PR (started); B and D have not started.
    expect(listCells(model).map(c => c.state === 'queued')).toEqual([false, false, true, true]);
    const pulse = buildPulseSegments(tasks.map(t => ({ ...t, worker: t.workers[0] ? { ...t.workers[0] } : null })), { order: feedStripOrder(tasks) });
    expect(pulse.map(s => tok(s.taskId))).toEqual(['A', 'C', 'B', 'D']);
  });

  it('without the strip order the pulse still draws creation order (the divergence this closes)', () => {
    const pulse = buildPulseSegments(dagTasks(spec));
    expect(pulse.map(s => tok(s.taskId))).toEqual(['A', 'B', 'C', 'D']);
  });

  it('phases interleaved by dependency order become runs, never a reorder', () => {
    const tasks = dagTasks(spec).map(toListTaskRow).map(t => ({
      ...t,
      ...(tok(t.id) === 'B' ? { missionPhaseIndex: 1, missionPhaseLabel: 'One' } : { missionPhaseIndex: 2, missionPhaseLabel: 'Two' }),
    }));
    const { model } = listCard(tasks);
    expect(model.phases.map(p => [p.label, p.cells.map(c => tok(c.taskId))])).toEqual([
      ['Two', ['A', 'C']], ['One', ['B']], ['Two', ['D']],
    ]);
    expect(new Set(model.phases.map(p => p.key)).size).toBe(model.phases.length);
  });
});

describe('countable set', () => {
  const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['A'] }, states: { A: 'landed' } };
  const tok = tokenOf(spec);
  const withCancelledC = () => dagTasks(spec).map(t => (tok(t.id) === 'C' ? { ...t, status: 'cancelled' } : t));

  it('a cancelled task draws no glyph on the list, and glyphs == n/N', () => {
    const { view, model } = listCard(withCancelledC().map(toListTaskRow));
    const cells = listCells(model);
    expect(cells.map(c => tok(c.taskId))).toEqual(['A', 'B']);
    expect(cells.length).toBe(view.total);
    expect(cells.filter(c => c.state === 'done').length).toBe(view.done);
  });

  it('is absent from the strip order, so no surface can place it', () => {
    expect(feedStripOrder(withCancelledC()).map(tok)).toEqual(['A', 'B']);
  });
});

describe('cross-mission blocker', () => {
  // B waits on another mission's open task; A, C are free.
  const other = '00000000-0000-4000-8000-0000000000ff';
  const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { C: ['A'] }, external: { B: [other] } };
  const tok = tokenOf(spec);
  const externalDeps = [{ id: other, title: 'Other mission task', status: 'pending', workers: [] }];

  it('the list judges it from the page task index and draws the detail order', () => {
    const board = dagBoard(spec, { externalDeps });
    const taskIndex = new Map([[other, { status: 'pending', workers: [], title: 'Other mission task' }]]);
    const { model } = listCard(dagTasks(spec).map(toListTaskRow), { taskIndex });
    expect(listCells(model).map(c => tok(c.taskId))).toEqual(stripOrder(board).map(tok));
  });

  it('an external blocker adds no on-strip edge', () => {
    expect(dagBoard(spec, { externalDeps }).tasks[dagId(spec, 'B')].offStrip).toHaveLength(1);
  });
});
