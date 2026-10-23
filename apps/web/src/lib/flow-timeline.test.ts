/**
 * The Flow timeline's rules (docs/specs/mission-flow-timeline.md), over board
 * models built through the real `buildMissionBoard`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missionFlowFixture } from '@/app/app/dev/fixtures/mission-flow-fixtures';
import { dagBoard, dagId, type DagSpec } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import {
  buildFlowTimeline, criticalPath, criticalPathLine, defaultFlowSelection, finishDependsOn, flowAxisTicks, flowEdgePaths, flowEdges, flowLit,
  flowTaskName, missionFinishClause, FINISH_NAMES_MAX, FLOW_AUDIT_WAIT_MS, FLOW_DEFAULT_TASK_MS, FLOW_FOLD_ABOVE, FLOW_ROW_UNITS, FLOW_X_UNITS, layoutFlowTimeline, shouldFoldMerged,
  type FlowTask,
  flowTickNearNow,
} from './flow-timeline';
import { stripMarks, stripOrder } from './mission-task-strip';

const word = (s: string) => ({ running: 'Building', review: 'Auditing' } as Record<string, string>)[s] ?? s;
const MIN = 60_000;

function flow(variant: 'small' | 'wide') {
  const f = missionFlowFixture(variant);
  const tl = buildFlowTimeline({ model: f.model, sameFiles: f.sameFiles, expectedMinutes: f.expectedMinutes });
  const tick = (n: number) => tl.tasks[f.idOf(n)].tick;
  return { ...f, tl, tick };
}

describe('rows (R-1, R-2)', () => {
  it('one row per task, in the strip order', () => {
    const { model, tl } = flow('small');
    expect(tl.order).toEqual(stripOrder(model));
    expect(Object.keys(tl.tasks).sort()).toEqual(Object.keys(model.tasks).sort());
    expect(layoutFlowTimeline(tl).rows.map(r => (r.kind === 'task' ? r.id : null))).toEqual(tl.order);
  });

  it('every dependency is above its dependent', () => {
    const { tl } = flow('wide');
    for (const g of tl.gates) {
      if (g.kind === 'depends') expect(tl.order.indexOf(g.from)).toBeLessThan(tl.order.indexOf(g.to));
    }
  });

  it('a started task runs from its first run; a landed one ends at its merge', () => {
    const { tl, idOf, model } = flow('small');
    const t1 = tl.tasks[idOf(1)];
    expect(t1.kind).toBe('done');
    expect(t1.start).toBe(model.startedAt);
    expect(t1.end).toBe(model.startedAt + 30 * MIN);
    const t4 = tl.tasks[idOf(4)];
    expect(t4.kind).toBe('run');
    expect(t4.start).toBe(model.startedAt + 162 * MIN);
    expect(t4.solidEnd).toBe(tl.now);
  });

  it('an unstarted task starts at its last gate plus the audit wait, for its expected size', () => {
    const { tl, idOf } = flow('small');
    const t6 = tl.tasks[idOf(6)];
    const gatesEnd = Math.max(tl.tasks[idOf(3)].end, tl.tasks[idOf(4)].end);
    expect(t6.kind).toBe('plan');
    expect(t6.start).toBe(gatesEnd + FLOW_AUDIT_WAIT_MS);
    expect(t6.end - t6.start).toBe(70 * MIN);
  });

  it('without an expected size the duration is the constant, and never in the past', () => {
    const f = missionFlowFixture('small');
    const tl = buildFlowTimeline({ model: f.model });
    const t5 = tl.tasks[f.idOf(5)];
    expect(t5.end - t5.start).toBe(FLOW_DEFAULT_TASK_MS);
    for (const id of tl.order) if (tl.tasks[id].kind === 'plan') expect(tl.tasks[id].start).toBeGreaterThanOrEqual(tl.now);
  });
});

describe('critical path (R-15..R-17)', () => {
  it('is the longest path through the gates', () => {
    // A(10m) → C and B(60m) → C: the path runs through B.
    const order = ['A', 'B', 'C'];
    const tasks: Record<string, Pick<FlowTask, 'end' | 'gates'>> = {
      A: { end: 10, gates: [] },
      B: { end: 60, gates: [] },
      C: { end: 90, gates: [{ from: 'A', to: 'C', kind: 'depends' }, { from: 'B', to: 'C', kind: 'depends' }] },
    };
    expect(criticalPath(order, tasks)).toEqual(['B', 'C']);
    tasks.A.end = 70;
    expect(criticalPath(order, tasks)).toEqual(['A', 'C']);
  });

  it('a longer chain beats a heavier single task', () => {
    const spec: DagSpec = { tasks: ['A', 'B', 'C', 'D'], edges: { B: ['A'], C: ['B'] } };
    const model = dagBoard(spec);
    const tl = buildFlowTimeline({ model, expectedMinutes: { [dagId(spec, 'A')]: 20, [dagId(spec, 'B')]: 20, [dagId(spec, 'C')]: 20, [dagId(spec, 'D')]: 50 } });
    expect(tl.critical).toEqual(['A', 'B', 'C'].map(n => dagId(spec, n)));
  });

  it('the line names the first unlanded task on it, then the rest, by name', () => {
    const { tl, model } = flow('small');
    expect(criticalPathLine(tl, word, flowTaskName(model))).toBe('Finish is set by Missions portfolio list (building), then Mission detail: gates and repair → Final audit at 360, 390 and desktop.');
  });

  it('the Flow tab opens on the task setting the finish', () => {
    const { tl, idOf } = flow('small');
    expect(defaultFlowSelection(tl)).toBe(idOf(4));
  });

  it('no line once every task on it has landed', () => {
    const model = dagBoard({ tasks: ['A', 'B'], edges: { B: ['A'] }, states: { A: 'landed', B: 'landed' } });
    expect(criticalPathLine(buildFlowTimeline({ model }), word, flowTaskName(model))).toBeNull();
  });

  it('a cycle terminates', () => {
    const model = dagBoard({ tasks: ['A', 'B'], edges: { A: ['B'], B: ['A'] } });
    const tl = buildFlowTimeline({ model });
    expect(tl.critical.length).toBeGreaterThan(0);
    expect(new Set(tl.critical).size).toBe(tl.critical.length);
  });
});

describe('same-files edges gate (R-5, R-6)', () => {
  it('a same-files wait is a gate: it holds the start and is drawn', () => {
    const { tl, idOf } = flow('wide');
    const g = tl.gates.find(x => x.from === idOf(5) && x.to === idOf(10));
    expect(g?.kind).toBe('same_files');
    expect(tl.tasks[idOf(10)].start).toBe(tl.tasks[idOf(5)].end + FLOW_AUDIT_WAIT_MS);
  });

  it('without it, the task starts after its stored dependency alone', () => {
    const f = missionFlowFixture('wide');
    const tl = buildFlowTimeline({ model: f.model, expectedMinutes: f.expectedMinutes });
    expect(tl.gates.some(x => x.to === f.idOf(10) && x.from === f.idOf(5))).toBe(false);
    expect(tl.tasks[f.idOf(10)].start).toBe(tl.now);
  });

  it('a same-files wait holds the start but never sets the critical path (Navigation R-22)', () => {
    const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { C: ['B'] } };
    const model = dagBoard(spec);
    const [A, B, C] = ['A', 'B', 'C'].map(n => dagId(spec, n));
    const expectedMinutes = { [A]: 120, [B]: 30, [C]: 30 };
    const tl = buildFlowTimeline({ model, sameFiles: { [C]: [A] }, expectedMinutes });
    expect(tl.tasks[C].start).toBeGreaterThanOrEqual(tl.tasks[A].end + FLOW_AUDIT_WAIT_MS);
    // Through declared dependencies alone, A (120m) finishes after B → C (70m with the audit wait).
    expect(tl.critical).toEqual([A]);
    expect(tl.critical).toEqual(buildFlowTimeline({ model, expectedMinutes }).critical);
  });

  it('ignores a same-files wait on a task outside the mission, on itself, or one that duplicates a dependency', () => {
    const spec: DagSpec = { tasks: ['A', 'B'], edges: { B: ['A'] } };
    const model = dagBoard(spec);
    const [A, B] = ['A', 'B'].map(n => dagId(spec, n));
    const tl = buildFlowTimeline({ model, sameFiles: { [B]: [A, B, 'not-on-this-mission'] } });
    expect(tl.gates).toEqual([{ from: A, to: B, kind: 'depends' }]);
  });
});

describe('edge lighting matches the strip (R-9..R-11)', () => {
  const cases: Array<['small' | 'wide', number]> = [['small', 4], ['small', 6], ['small', 7], ['small', 1], ['wide', 2], ['wide', 9], ['wide', 13], ['wide', 5]];
  for (const [v, n] of cases) {
    it(`${v} · select ${String(n).padStart(2, '0')}: lit = selection + what the strip marks`, () => {
      const { model, tl, idOf } = flow(v);
      const sel = idOf(n);
      const lit = flowLit(model, sel);
      expect([...lit].sort()).toEqual([sel, ...stripMarks(model, sel).reached].sort());
      for (const e of flowEdges(tl, lit)) expect(e.on).toBe(lit.has(e.from) && lit.has(e.to));
    });
  }

  it('a held task lights upstream; an active one downstream; a landed one nothing', () => {
    const { model, tl, idOf } = flow('small');
    const on = (n: number) => flowEdges(tl, flowLit(model, idOf(n))).filter(e => e.on).map(e => `${tl.tasks[e.from].tick}>${tl.tasks[e.to].tick}`).sort();
    expect(on(6)).toEqual(['03>06', '04>06']);
    expect(on(4)).toEqual(['04>06', '06>07']);
    expect(on(1)).toEqual([]);
  });

  it('marks critical edges', () => {
    const { tl } = flow('small');
    const crit = flowEdges(tl, new Set()).filter(e => e.critical).map(e => [e.from, e.to]);
    expect(crit).toEqual(tl.critical.slice(0, -1).map((id, i) => [id, tl.critical[i + 1]]));
  });
});

describe('merged fold (R-12..R-14)', () => {
  it('folds above the threshold when two or more have merged', () => {
    const { tl } = flow('wide');
    expect(tl.order.length).toBeGreaterThan(FLOW_FOLD_ABOVE);
    expect(shouldFoldMerged(tl)).toBe(true);
    const layout = layoutFlowTimeline(tl);
    expect(layout.rows[0].kind).toBe('merged');
    const merged = layout.rows[0].kind === 'merged' ? layout.rows[0].ids : [];
    expect(merged.every(id => tl.tasks[id].kind === 'done')).toBe(true);
    expect(merged.length).toBe(3);
    expect(layout.rows.length).toBe(tl.order.length - merged.length + 1);
  });

  it('never at or below the threshold', () => {
    const { tl } = flow('small');
    expect(tl.order.length).toBeLessThanOrEqual(FLOW_FOLD_ABOVE);
    expect(shouldFoldMerged(tl)).toBe(false);
    const nine = dagBoard({ tasks: 'ABCDEFGHI'.split('').slice(0, FLOW_FOLD_ABOVE), states: { A: 'landed', B: 'landed', C: 'landed' } });
    expect(shouldFoldMerged(buildFlowTimeline({ model: nine }))).toBe(false);
  });

  it('never for a single merged task', () => {
    const model = dagBoard({ tasks: 'ABCDEFGHI'.split(''), states: { A: 'landed' } });
    expect(shouldFoldMerged(buildFlowTimeline({ model }))).toBe(false);
  });

  it('opened, every task has its own row again', () => {
    const { tl } = flow('wide');
    const open = layoutFlowTimeline(tl, { mergedOpen: true });
    expect(open.folded).toBe(false);
    expect(open.foldable).toBe(true);
    expect(open.rows.length).toBe(tl.order.length);
  });

  it('edges out of a folded task leave from the merged row', () => {
    const { tl, idOf } = flow('wide');
    const layout = layoutFlowTimeline(tl);
    expect(layout.rowOf.get(idOf(2))).toBe(0);
    const paths = flowEdgePaths(tl, layout, flowEdges(tl, new Set()));
    const from2 = paths.filter(p => p.from === idOf(2));
    expect(from2.length).toBeGreaterThan(0);
    for (const p of from2) expect(p.d.startsWith('M')).toBe(true);
    // Merged → merged edges collapse into the row; none is drawn.
    expect(paths.some(p => p.from === idOf(1) && p.to === idOf(2))).toBe(false);
  });
});

describe('rows never grow horizontally (R-18)', () => {
  it('every horizontal position is a percentage of the window', () => {
    for (const v of ['small', 'wide'] as const) {
      const { tl } = flow(v);
      for (const mergedOpen of [false, true]) {
        const layout = layoutFlowTimeline(tl, { mergedOpen });
        const bars = layout.rows.flatMap(r => (r.kind === 'task' ? [r.bar] : r.bars));
        for (const b of bars) {
          expect(b.left).toBeGreaterThanOrEqual(0);
          expect(b.left + b.solid + b.forecast).toBeLessThanOrEqual(100.0001);
          if (b.p80 != null) expect(b.left + b.p80).toBeLessThanOrEqual(100.0001);
        }
        expect(layout.nowAt).toBeGreaterThanOrEqual(0);
        expect(layout.nowAt).toBeLessThanOrEqual(100);
      }
    }
  });

  it('edges are in track units: x within the track, y on a row centre', () => {
    const { tl } = flow('wide');
    const layout = layoutFlowTimeline(tl, { mergedOpen: true });
    for (const p of flowEdgePaths(tl, layout, flowEdges(tl, new Set()))) {
      const nums = p.d.match(/[MHV]-?[\d.]+(,-?[\d.]+)?/g)!;
      const [x1, y1] = nums[0].slice(1).split(',').map(Number);
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(FLOW_X_UNITS);
      expect((y1 - FLOW_ROW_UNITS / 2) % FLOW_ROW_UNITS).toBe(0);
    }
  });

  it('the layout functions take no width', () => {
    const src = readFileSync(join(import.meta.dir, 'flow-timeline.ts'), 'utf8');
    expect(src).not.toMatch(/\b(width|clientWidth|innerWidth|offsetWidth|getBoundingClientRect)\b/);
    expect(layoutFlowTimeline.length).toBeLessThanOrEqual(2);
  });

  it('axis ticks stay at six or fewer over any span', () => {
    for (const hours of [0.5, 3, 9, 30, 24 * 9]) {
      const ticks = flowAxisTicks({ from: 0, to: hours * 3_600_000 });
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[0]).toEqual({ at: 0, label: '0' });
      for (const t of ticks) expect(t.at).toBeLessThanOrEqual(100);
    }
  });
});

describe('flowTickNearNow: an axis tick never runs into "now" (visual review round 2, "10dnow")', () => {
  it('hides a tick on top of now, hides it only on a phone when close, shows the rest', () => {
    expect(flowTickNearNow(100, 98)).toBe('hide');
    expect(flowTickNearNow(80, 92)).toBe('phone');
    expect(flowTickNearNow(40, 92)).toBe('show');
    expect(flowTickNearNow(100, null)).toBe('show');
  });
});

describe('finish depends on (Navigation d25d923d R-22, AC-18)', () => {
  // A → B → C → D → E, all unmerged, A running; F is short and off the path.
  const spec: DagSpec = { tasks: ['A', 'B', 'C', 'D', 'E', 'F'], edges: { B: ['A'], C: ['B'], D: ['C'], E: ['D'] }, states: { A: 'running' } };
  const model = dagBoard(spec);
  const ids = Object.fromEntries(spec.tasks.map(n => [n, dagId(spec, n)]));
  const name = flowTaskName(model);
  const all = Object.fromEntries(spec.tasks.map(n => [ids[n], 30]));

  it('three unmerged tasks, all estimated: the first, then the rest, by name', () => {
    const three: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['B'] }, states: { A: 'running' } };
    const m = dagBoard(three);
    const [A, B, C] = three.tasks.map(n => dagId(three, n));
    const clause = missionFinishClause(m, m.now, { [A]: 40, [B]: 30, [C]: 20 });
    const n = flowTaskName(m);
    expect(clause).toBe(`finish depends on ${n(A)}, then ${n(B)} → ${n(C)}`);
  });

  it('a path longer than three names ends +N', () => {
    expect(FINISH_NAMES_MAX).toBe(3);
    const tl = buildFlowTimeline({ model, expectedMinutes: all });
    expect(tl.critical).toEqual(['A', 'B', 'C', 'D', 'E'].map(n => ids[n]));
    expect(finishDependsOn(tl, name)).toBe(`finish depends on ${name(ids.A)}, then ${name(ids.B)} → ${name(ids.C)} +2`);
    expect(criticalPathLine(tl, word, name)).toBe(`Finish is set by ${name(ids.A)} (building), then ${name(ids.B)} → ${name(ids.C)} +2.`);
  });

  it('one task on the path without an estimate: no clause (a default duration never counts)', () => {
    const { [ids.C]: _gone, ...missing } = all;
    expect(missionFinishClause(model, model.now, missing)).toBeNull();
    expect(missionFinishClause(model, model.now, {})).toBeNull();
    expect(missionFinishClause(model, model.now, undefined)).toBeNull();
  });

  it('an estimate missing off the path does not matter', () => {
    const { [ids.F]: _gone, ...offPath } = all;
    expect(missionFinishClause(model, model.now, offPath)).toStartWith(`finish depends on ${name(ids.A)}`);
  });

  it('a merged task on the path needs no estimate; the clause starts at the first unmerged one', () => {
    const s: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['B'] }, states: { A: 'landed', B: 'running' } };
    const m = dagBoard(s);
    const [, B, C] = s.tasks.map(n => dagId(s, n));
    const n = flowTaskName(m);
    expect(missionFinishClause(m, m.now, { [B]: 30, [C]: 30 })).toBe(`finish depends on ${n(B)}, then ${n(C)}`);
  });

  it('the path all merged: no clause', () => {
    const s: DagSpec = { tasks: ['A', 'B'], edges: { B: ['A'] }, states: { A: 'landed', B: 'landed' } };
    const m = dagBoard(s);
    expect(missionFinishClause(m, m.now, Object.fromEntries(s.tasks.map(n => [dagId(s, n), 30])))).toBeNull();
  });

  it('Flow (with its same-files waits) and the summary name the same first task', () => {
    for (const v of ['small', 'wide'] as const) {
      const f = missionFlowFixture(v);
      const flowTl = buildFlowTimeline({ model: f.model, sameFiles: f.sameFiles, expectedMinutes: f.expectedMinutes });
      const n = flowTaskName(f.model);
      const head = defaultFlowSelection(flowTl)!;
      expect(criticalPathLine(flowTl, word, n)).toStartWith(`Finish is set by ${n(head)} (`);
      expect(missionFinishClause(f.model, f.model.now, f.expectedMinutes)).toStartWith(`finish depends on ${n(head)}`);
    }
  });
});
