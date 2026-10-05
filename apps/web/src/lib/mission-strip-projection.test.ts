/**
 * The one strip projection (`buildBoardCells` → `stripProjection`) and the
 * compact-lanes EXPERIMENT over it: the mission page, the missions list and
 * Home must draw the same task ids, in the same dependency-first order, on
 * the same lanes. Fixtures are built through the real builders.
 */
import { describe, expect, it } from 'bun:test';
import {
  LANE_SHAPE_NAMES,
  LANE_SHAPES,
  laneShapeFixture,
  parseLanesFixtureParams,
  toListTaskRow,
} from '@/app/app/dev/fixtures/mission-strip-lanes-fixtures';
import { dagBoard, dagId, dagTasks, DAG_SPECS, type DagSpec } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import { buildMissionCardView, summarizeMissionForCard } from './mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow, type MissionListCardModel } from './mission-list-card';
import type { MissionBoardModel } from './mission-board';
import { parseStripLayout, stripOrder, stripProjection, type StripLane } from './mission-task-strip';

const NOW = Date.UTC(2026, 0, 1, 13, 0, 0);

const tokenOf = (spec: DagSpec) => {
  const byId = new Map(spec.tasks.map(t => [dagId(spec, t), t]));
  return (id: string) => byId.get(id) ?? id;
};

/** Lanes by token, from the mission page's projection. */
function boardLanes(spec: DagSpec, board: MissionBoardModel): Record<string, StripLane> {
  const tok = tokenOf(spec);
  const { order, lanes } = stripProjection(board);
  return Object.fromEntries(order.map(id => [tok(id), lanes.get(id)!]));
}

const listCells = (m: MissionListCardModel) => m.phases.flatMap(p => p.cells);

function listCard(tasks: ListTaskRow[], opts: Parameters<typeof buildMissionListCard>[3] = {}) {
  const row: ListMissionRow = { id: 'fx-m', title: 'Example', status: 'active', executor: 'runner', createdAt: new Date(NOW - 3_600_000), tasks };
  const summary = summarizeMissionForCard(row, { now: NOW });
  const view = buildMissionCardView(row, { from: 'missions', now: NOW, summary });
  return { view, model: buildMissionListCard(row, view, summary, { now: NOW, ...opts }) };
}

describe('compact lanes per shape', () => {
  const lanesOf = (name: keyof typeof LANE_SHAPES) => {
    const spec: DagSpec = LANE_SHAPES[name].spec;
    return boardLanes(spec, dagBoard(spec));
  };

  it('linear: stays flat', () => {
    expect(lanesOf('linear')).toEqual({ A: 0, B: 0, C: 0, D: 0 });
  });
  it('fan-out: the parent on the line, its children split around it', () => {
    expect(lanesOf('fan-out')).toEqual({ A: 0, B: -1, C: 1 });
  });
  it('fan-in: the roots split, the join sits on the line', () => {
    expect(lanesOf('fan-in')).toEqual({ B: -1, C: 1, D: 0 });
  });
  it('diamond: split, then join', () => {
    expect(lanesOf('diamond')).toEqual({ A: 0, B: -1, C: 1, D: 0 });
  });
  it('deep chain (>8): every cell on one lane', () => {
    const lanes = lanesOf('deep');
    expect(Object.keys(lanes)).toHaveLength(10);
    expect(new Set(Object.values(lanes))).toEqual(new Set([0]));
  });
  it('a branch keeps its lane down its own chain', () => {
    const spec: DagSpec = { tasks: ['A', 'B', 'C', 'D'], edges: { B: ['A'], C: ['A'], D: ['B'] } };
    expect(boardLanes(spec, dagBoard(spec))).toEqual({ A: 0, B: -1, C: 1, D: -1 });
  });
  it('a wide fan-out never leaves the three lanes', () => {
    const lanes = Object.values(boardLanes(DAG_SPECS.wide, dagBoard(DAG_SPECS.wide)));
    expect(lanes).toHaveLength(31);
    for (const l of lanes) expect([-1, 0, 1]).toContain(l);
  });
  it('lanes read edges, not state: landing work does not move a cell', () => {
    const before: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['A'] } };
    const after: DagSpec = { ...before, states: { A: 'landed', B: 'landed', C: 'running' } };
    expect(boardLanes(after, dagBoard(after))).toEqual(boardLanes(before, dagBoard(before)));
  });
});

describe('independent chains', () => {
  const spec: DagSpec = LANE_SHAPES['two-chains'].spec;
  const board = dagBoard(spec);
  const tok = tokenOf(spec);
  it('are drawn one after the other, never interleaved', () => {
    expect(stripOrder(board).map(tok)).toEqual(['A', 'B', 'C', 'X', 'Y', 'Z']);
  });
  it('the second opens with a break, and neither chain leaves its line', () => {
    const p = stripProjection(board);
    expect([...p.breaks].map(tok)).toEqual(['X']);
    expect(new Set(p.lanes.values())).toEqual(new Set([0]));
  });
  it('singletons next to singletons do not break (a flat mission stays flat)', () => {
    const flat: DagSpec = { tasks: ['A', 'B', 'C'] };
    expect(stripProjection(dagBoard(flat)).breaks.size).toBe(0);
  });
});

describe('detail, missions list and Home draw one projection', () => {
  for (const name of LANE_SHAPE_NAMES) {
    it(`${name}: same ids, same order, same lanes, same breaks`, () => {
      const fx = laneShapeFixture(name, NOW);
      const detail = stripProjection(fx.board);
      // The list card and Home's row read the same model (`model.phases`).
      const cells = listCells(fx.list);
      expect(cells.map(c => c.taskId)).toEqual(detail.order);
      expect(cells.map(c => c.lane)).toEqual(detail.order.map(id => detail.lanes.get(id)!));
      expect(cells.filter(c => c.break).map(c => c.taskId)).toEqual([...detail.breaks]);
    });
  }

  it('every dependency is left of its dependent on every surface', () => {
    for (const name of LANE_SHAPE_NAMES) {
      const spec: DagSpec = LANE_SHAPES[name].spec;
      const at = new Map(listCells(laneShapeFixture(name, NOW).list).map((c, i) => [c.taskId, i]));
      for (const [t, deps] of Object.entries(spec.edges ?? {})) {
        for (const d of deps) expect(at.get(dagId(spec, d))!).toBeLessThan(at.get(dagId(spec, t))!);
      }
    }
  });
});

describe('Home field repro: a dependent filed before its upstream', () => {
  // B was filed second but depends on C, filed third and already in CI.
  const spec: DagSpec = { tasks: ['A', 'B', 'C', 'D'], edges: { B: ['C'], C: ['A'], D: ['B'] }, states: { A: 'landed', C: 'review' } };
  const tok = tokenOf(spec);

  it('the in-CI upstream draws before its empty dependent, on all three surfaces', () => {
    const board = dagBoard(spec);
    const { model } = listCard(dagTasks(spec).map(toListTaskRow));
    expect(stripOrder(board).map(tok)).toEqual(['A', 'C', 'B', 'D']);
    expect(listCells(model).map(c => tok(c.taskId))).toEqual(['A', 'C', 'B', 'D']);
    // C has a green PR (started); B and D have not started.
    expect(listCells(model).map(c => c.state === 'queued')).toEqual([false, false, true, true]);
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
  it('a cancelled sibling draws no glyph and splits no lane', () => {
    const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['A'] }, states: { A: 'landed' } };
    const tasks = dagTasks(spec).map(toListTaskRow).map(t => (tok(t.id) === 'C' ? { ...t, status: 'cancelled' } : t));
    function tok(id: string) { return tokenOf(spec)(id); }
    const { view, model } = listCard(tasks);
    const cells = listCells(model);
    expect(cells.map(c => tok(c.taskId))).toEqual(['A', 'B']);
    expect(cells.map(c => c.lane)).toEqual([0, 0]);
    // rendered glyphs == denominator, done glyphs == numerator
    expect(cells.length).toBe(view.total);
    expect(cells.filter(c => c.state === 'done').length).toBe(view.done);
  });

  it('every shape: glyphs == n/N', () => {
    for (const name of LANE_SHAPE_NAMES) {
      const fx = laneShapeFixture(name, NOW);
      const cells = listCells(fx.list);
      expect(cells.length).toBe(fx.list.counts.total);
      expect(cells.filter(c => c.state === 'done').length).toBe(fx.list.counts.done);
    }
  });
});

describe('cross-mission blocker', () => {
  // B waits on another mission's open task; A, C are free.
  const other = '00000000-0000-4000-8000-0000000000ff';
  const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { C: ['A'] }, external: { B: [other] } };
  const tok = tokenOf(spec);
  const externalDeps = [{ id: other, title: 'Other mission task', status: 'pending', workers: [] }];

  it('adds no on-strip edge: no lane, no level, no break of its own', () => {
    const board = dagBoard(spec, { externalDeps });
    const p = stripProjection(board);
    expect(board.tasks[dagId(spec, 'B')].offStrip).toHaveLength(1);
    expect(p.lanes.get(dagId(spec, 'B'))).toBe(0);
    expect(board.tasks[dagId(spec, 'B')].level).toBe(1);
  });

  it('the list judges it from the page task index, and draws the detail order', () => {
    const board = dagBoard(spec, { externalDeps });
    const taskIndex = new Map([[other, { status: 'pending', workers: [], title: 'Other mission task' }]]);
    const { model } = listCard(dagTasks(spec).map(toListTaskRow), { taskIndex });
    expect(listCells(model).map(c => tok(c.taskId))).toEqual(stripOrder(board).map(tok));
  });
});

describe('the switch', () => {
  it('flat unless the page asks for lanes', () => {
    expect(parseStripLayout(undefined)).toBe('flat');
    expect(parseStripLayout('nope')).toBe('flat');
    expect(parseStripLayout('lanes')).toBe('lanes');
    expect(parseStripLayout(['lanes', 'flat'])).toBe('lanes');
  });
  it('the fixture shows both columns by default', () => {
    expect(parseLanesFixtureParams(new URLSearchParams('')).layouts).toEqual(['flat', 'lanes']);
    expect(parseLanesFixtureParams(new URLSearchParams('layout=lanes&shape=diamond'))).toEqual({ layouts: ['lanes'], shapes: ['diamond'] });
  });
});
