/**
 * The Landed strip's rules (docs/specs/mission-progress-strip-ordering.md),
 * over board models built from fixtures through the real `buildMissionBoard`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dagBoard, dagId, DAG_SPECS, type DagSpec } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import type { MissionBoardModel } from './mission-board';
import {
  activeIndices, defaultStripSelection, heldCount, nextOpenIndex, slotMarks, stepIndex, stripBlockerCount,
  stripCaretLeft, stripKeyTarget, stripMarks, stripOrder, stripOrdinal, stripSelectionReason, stripSlots, stripState,
  stripTick, type StripMark,
} from './mission-task-strip';

/** The strip order as task tokens. */
function names(spec: DagSpec, model: MissionBoardModel): string[] {
  const byId = new Map(spec.tasks.map(t => [dagId(spec, t), t]));
  return stripOrder(model).map(id => byId.get(id)!);
}

/** Marks keyed by token, plus the reason line, for a selected token. */
function select(spec: DagSpec, model: MissionBoardModel, name: string) {
  const order = stripOrder(model);
  const byId = new Map(spec.tasks.map(t => [dagId(spec, t), t]));
  const sel = stripMarks(model, dagId(spec, name));
  const marks: Record<string, StripMark> = {};
  for (const [id, m] of sel.marks) marks[byId.get(id)!] = m;
  const reason = stripSelectionReason(model, dagId(spec, name), id => stripTick(order.indexOf(id)));
  return { direction: sel.direction, marks, reason };
}

const stateOf = (spec: DagSpec, model: MissionBoardModel, name: string) => stripState(model, dagId(spec, name));

/** AC-1: every on-strip edge points left. */
function expectTopological(spec: DagSpec, model: MissionBoardModel) {
  const at = new Map(names(spec, model).map((n, i) => [n, i]));
  for (const [t, deps] of Object.entries(spec.edges ?? {})) {
    for (const d of deps) expect(at.get(d)!).toBeLessThan(at.get(t)!);
  }
}

describe('linear chain A→B→C→D→E (§7.1)', () => {
  const spec = DAG_SPECS.linear;
  const model = dagBoard(spec);
  it('orders by dependency, one level per link', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expectTopological(spec, model);
  });
  it('C is blocked behind running B; D and E are queued behind a held chain', () => {
    expect(['A', 'B', 'C', 'D', 'E'].map(n => stateOf(spec, model, n))).toEqual(['landed', 'running', 'blocked', 'queued', 'queued']);
  });
  it('selecting E marks D direct and C, B transitive, never landed A', () => {
    const s = select(spec, model, 'E');
    expect(s.direction).toBe('upstream');
    expect(s.marks).toEqual({ D: 'direct', C: 'transitive', B: 'transitive' });
    expect(s.reason).toBe('After 04 D (+2 upstream).');
    expect(stripOrdinal(model.tasks[dagId(spec, 'E')], 4)).toBe('05 · LEVEL 5 OF 5');
  });
  it('selecting running B marks what it unblocks', () => {
    const s = select(spec, model, 'B');
    expect(s.direction).toBe('downstream');
    expect(s.marks).toEqual({ C: 'direct', D: 'transitive', E: 'transitive' });
    expect(s.reason).toBe('Unblocks 03 C (+2 downstream).');
  });
});

describe('fan-out A→{B, C, D} (§7.2)', () => {
  const spec = DAG_SPECS['fan-out'];
  const model = dagBoard(spec);
  it('puts the root first and its dependents in creation order', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'C', 'D']);
    expectTopological(spec, model);
  });
  it('selecting A marks all three dependents direct', () => {
    const s = select(spec, model, 'A');
    expect(s.marks).toEqual({ B: 'direct', C: 'direct', D: 'direct' });
    expect(s.reason).toBe('Unblocks 02 B, 03 C (+1 downstream).');
  });
});

describe('fan-in {B, C}→D (§7.3)', () => {
  const spec = DAG_SPECS['fan-in'];
  const model = dagBoard(spec);
  it('review before running within a level, the join last', () => {
    expect(names(spec, model)).toEqual(['B', 'C', 'D']);
  });
  it('a dependency in review still holds (gate parity, AC-8): both blockers are direct', () => {
    expect(stateOf(spec, model, 'D')).toBe('blocked');
    expect(select(spec, model, 'D').marks).toEqual({ B: 'direct', C: 'direct' });
    expect(stripBlockerCount(model.tasks[dagId(spec, 'D')])).toBe(2);
  });
});

describe('diamond A→B, A→C, B→D, C→D (§7.4)', () => {
  const spec: DagSpec = {
    tasks: ['A', 'B', 'C', 'D'],
    edges: { B: ['A'], C: ['A'], D: ['B', 'C'] },
    states: { A: 'landed', B: 'landed', C: 'running' },
  };
  const model = dagBoard(spec);
  it('levels A1, B2, C2, D3', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'C', 'D']);
    expect(['A', 'B', 'C', 'D'].map(n => model.tasks[dagId(spec, n)].level)).toEqual([1, 2, 2, 3]);
  });
  it('selecting D marks only C; satisfied B and A are never marked', () => {
    expect(select(spec, model, 'D').marks).toEqual({ C: 'direct' });
  });
});

describe('sibling chains A→B→C and X→Y (§7.5, AC-6)', () => {
  const spec: DagSpec = {
    tasks: ['A', 'X', 'B', 'Y', 'C'],
    edges: { B: ['A'], C: ['B'], Y: ['X'] },
    states: { X: 'running' },
  };
  const model = dagBoard(spec);
  it('keeps each component contiguous, earliest-created component first', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'C', 'X', 'Y']);
  });
  it('selecting C marks nothing in X–Y', () => {
    expect(select(spec, model, 'C').marks).toEqual({ B: 'direct', A: 'transitive' });
  });
});

describe('cross-mission blocker (§7.6, AC-9)', () => {
  const Z = '00000000-0000-4000-8000-00000000ffff';
  const spec: DagSpec = { tasks: ['A', 'B'], edges: { B: ['A'] }, states: { A: 'landed' }, external: { B: [Z] } };
  const running = { id: Z, title: 'feat: other mission work', status: 'in_progress', workers: [] };
  it('an off-strip blocker holds the cell: blocked, never ready, count 1, named in the reason', () => {
    const model = dagBoard(spec, { externalDeps: [running] });
    const b = model.tasks[dagId(spec, 'B')];
    expect(b.status).toBe('blocked');
    expect(stateOf(spec, model, 'B')).toBe('blocked');
    expect(stripBlockerCount(b)).toBe(1);
    const s = select(spec, model, 'B');
    expect(s.marks).toEqual({});
    expect(s.reason).toBe('After feat: other mission work · other mission.');
  });
  it('a satisfied off-strip dependency holds nothing', () => {
    const model = dagBoard(spec, { externalDeps: [{ ...running, status: 'completed' }] });
    expect(stateOf(spec, model, 'B')).toBe('ready');
  });
});

describe('partially complete chain with an out-of-order landing (§7.7, AC-5)', () => {
  const spec: DagSpec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['B'] }, states: { B: 'landed' } };
  const model = dagBoard(spec);
  it('landed B stays right of the open dependency it landed before', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'C']);
    expect(['A', 'B', 'C'].map(n => stateOf(spec, model, n))).toEqual(['ready', 'landed', 'ready']);
  });
  it('selecting A or C marks nothing', () => {
    expect(select(spec, model, 'A').marks).toEqual({});
    expect(select(spec, model, 'C').marks).toEqual({});
  });
});

describe('the 14-cell field case (§7.8)', () => {
  const spec = DAG_SPECS.field;
  const model = dagBoard(spec);
  it('AC-2: A B F C E G H I J L K M D N', () => {
    expect(names(spec, model)).toEqual(['A', 'B', 'F', 'C', 'E', 'G', 'H', 'I', 'J', 'L', 'K', 'M', 'D', 'N']);
    expectTopological(spec, model);
  });
  it('ready, blocked and queued are distinguished', () => {
    expect(['G', 'H', 'I', 'J', 'M', 'D', 'N'].map(n => stateOf(spec, model, n)))
      .toEqual(['ready', 'blocked', 'blocked', 'queued', 'queued', 'queued', 'queued']);
  });
  it('AC-10: selecting D marks M direct and 05–11 transitive; all 8 blockers are marked and counted', () => {
    const s = select(spec, model, 'D');
    expect(s.marks).toEqual({ M: 'direct', E: 'transitive', G: 'transitive', H: 'transitive', I: 'transitive', J: 'transitive', L: 'transitive', K: 'transitive' });
    expect(s.reason).toBe('After 12 M (+7 upstream).');
    const d = model.tasks[dagId(spec, 'D')];
    expect(stripBlockerCount(d)).toBe(8);
    for (const b of d.blockers) expect(stripMarks(model, d.id).marks.has(b)).toBe(true);
    expect(stripOrdinal(d, 12)).toBe('13 · LEVEL 9 OF 10');
  });
  it('AC-11: selecting ready G marks what it unblocks, nothing left of it', () => {
    const s = select(spec, model, 'G');
    expect(s.marks).toEqual({ I: 'direct', D: 'direct', L: 'transitive', M: 'transitive', N: 'transitive' });
    expect(s.reason).toBe('Unblocks 08 I, 13 D (+3 downstream).');
  });
  it('AC-12: a landed cell marks nothing', () => {
    expect(select(spec, model, 'C').marks).toEqual({});
  });
  it('AC-3: G starting moves no cell out of its level', () => {
    const moved = dagBoard({ ...spec, states: { ...spec.states, G: 'running' } });
    const before = names(spec, model);
    const after = names(spec, moved);
    for (const n of spec.tasks) expect(moved.tasks[dagId(spec, n)].level).toBe(model.tasks[dagId(spec, n)].level);
    const changed = spec.tasks.filter(n => before.indexOf(n) !== after.indexOf(n));
    for (const n of changed) expect(model.tasks[dagId(spec, n)].level).toBe(4);
  });
  it('AC-4: deterministic', () => {
    expect(stripOrder(dagBoard(spec))).toEqual(stripOrder(dagBoard(spec)));
  });
  it('AC-15: Next open visits only active cells, from 01: 05, 06, 05', () => {
    const slots = stripSlots(model);
    const active = activeIndices(slots);
    let i = 0;
    const visits: string[] = [];
    for (let k = 0; k < 3; k++) { i = nextOpenIndex(active, i)!; visits.push(stripTick(i)); }
    expect(visits).toEqual(['05', '06', '05']);
    expect(heldCount(slots)).toBe(8);
  });
});

describe('cycles (§7.9, AC-17)', () => {
  const spec: DagSpec = { tasks: ['A', 'B', 'C', 'R'], edges: { A: ['B'], B: ['A'], C: ['A'] } };
  const model = dagBoard(spec);
  it('terminates and draws every task once', () => {
    const order = names(spec, model);
    expect([...order].sort()).toEqual(['A', 'B', 'C', 'R']);
  });
  it('a held cycle member still marks a blocker (CYC-3)', () => {
    expect(Object.keys(select(spec, model, 'A').marks)).toContain('B');
  });
  it('unreleased tasks sit after every released task of their component', () => {
    const chain: DagSpec = { tasks: ['R', 'A', 'B'], edges: { A: ['R', 'B'], B: ['A'] } };
    const m = dagBoard(chain);
    expect(names(chain, m)[0]).toBe('R');
  });
});

describe('the 64-cell cap (§7.11, AC-18)', () => {
  const tasks = Array.from({ length: 80 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  const states: Record<string, 'landed' | 'running'> = {};
  tasks.slice(0, 30).forEach(t => { states[t] = 'landed'; });
  states.T31 = 'running';
  const spec: DagSpec = { tasks, edges: { T33: ['T31'] }, states };
  const model = dagBoard(spec);
  it('folds the leftmost landed cells into one +17 summary, keeping live work', () => {
    const slots = stripSlots(model);
    expect(slots).toHaveLength(64);
    expect(slots[0].kind).toBe('fold');
    expect(slots[0].kind === 'fold' && slots[0].taskIds.length).toBe(17);
    const own = new Set(slots.filter(s => s.kind === 'task').map(s => s.id));
    for (const t of ['T31', 'T32', 'T33', 'T80']) expect(own.has(dagId(spec, t))).toBe(true);
  });
  it('folds trailing queued cells when there is not enough landed work', () => {
    const chain: DagSpec = { tasks, edges: Object.fromEntries(tasks.slice(1).map((t, i) => [t, [tasks[i]]])), states: { T01: 'running' } };
    const slots = stripSlots(dagBoard(chain));
    expect(slots).toHaveLength(64);
    expect(slots[63].kind).toBe('fold');
    expect(slots[63].state).toBe('queued');
  });
  it('a mark on a folded task marks its summary', () => {
    const slots = stripSlots(model);
    const marks = new Map<string, StripMark>([[dagId(spec, 'T01'), 'transitive']]);
    expect(slotMarks(slots, marks, 5)[0]).toBe('transitive');
  });
});

describe('Next open and the default selection (§9)', () => {
  it('AC-16: every open task held off-strip — nothing open, and the first held cell is the default', () => {
    const spec: DagSpec = { tasks: ['A', 'B'], edges: { B: ['A'] }, states: { A: 'landed' }, external: { B: ['x'] } };
    const model = dagBoard(spec, { externalDeps: [{ id: 'x', title: 'other', status: 'pending' }] });
    const slots = stripSlots(model);
    expect(activeIndices(slots)).toEqual([]);
    expect(heldCount(slots)).toBe(1);
    expect(defaultStripSelection(slots)).toBe(dagId(spec, 'B'));
  });
  it('prefers the focus task, then the first active cell, then the last', () => {
    const spec = DAG_SPECS.linear;
    const slots = stripSlots(dagBoard(spec));
    expect(defaultStripSelection(slots)).toBe(dagId(spec, 'B'));
    expect(defaultStripSelection(slots, dagId(spec, 'E'))).toBe(dagId(spec, 'E'));
    const done = stripSlots(dagBoard({ tasks: ['A', 'B'], states: { A: 'landed', B: 'landed' } }));
    expect(defaultStripSelection(done)).toBe(done[1].id);
    expect(defaultStripSelection([])).toBeNull();
  });
  it('next open wraps, and is the selection itself when it is the only one', () => {
    expect(nextOpenIndex([2, 4], 2)).toBe(4);
    expect(nextOpenIndex([2, 4], 4)).toBe(2);
    expect(nextOpenIndex([2], 2)).toBe(2);
    expect(nextOpenIndex([], 0)).toBeNull();
  });
});

describe('ordinal (§4)', () => {
  it('a cell with no on-strip edge shows its position alone, never "n / total"', () => {
    const spec: DagSpec = { tasks: ['A'] };
    const ordinal = stripOrdinal(dagBoard(spec).tasks[dagId(spec, 'A')], 0);
    expect(ordinal).toBe('01');
    expect(ordinal).not.toMatch(/\d+ \/ \d+/);
  });
});

describe('stepping', () => {
  it('arrows step with wrap; Home/End jump; other keys are not the strip\'s', () => {
    expect(stripKeyTarget('ArrowRight', 4, 5)).toBe(0);
    expect(stripKeyTarget('ArrowLeft', 0, 5)).toBe(4);
    expect(stripKeyTarget('Home', 3, 5)).toBe(0);
    expect(stripKeyTarget('End', 0, 5)).toBe(4);
    expect(stripKeyTarget('Enter', 0, 5)).toBeNull();
    expect(stepIndex(1, -3, 5)).toBe(3);
  });
});

describe('stripCaretLeft', () => {
  it('centres on cell i under a flex gap', () => {
    expect(stripCaretLeft(0, 10)).toBe('calc((100% - var(--strip-gap) * 9) * 0.05 + var(--strip-gap) * 0)');
    expect(stripCaretLeft(8, 10)).toBe('calc((100% - var(--strip-gap) * 9) * 0.85 + var(--strip-gap) * 8)');
  });
  it('ticks are two digits', () => {
    expect(stripTick(8)).toBe('09');
  });
});

describe('one adjacency derivation (AC-20, AC-21)', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');
  /** The body of a top-level function, up to the next top-level declaration. */
  const body = (file: string, name: string) => {
    const s = src(file);
    const at = s.search(new RegExp(`\\nexport function ${name}\\b|\\nfunction ${name}\\b`));
    expect(at).toBeGreaterThan(-1);
    const rest = s.slice(at + 1);
    const end = rest.slice(1).search(/\n(export )?(function|const|type|interface) /);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };
  it('no consumer walks dependsOn itself', () => {
    for (const [file, fn] of [
      ['mission-board.ts', 'buildMissionBoard'],
      ['condensed-timeline.ts', 'identifyChains'],
      ['condensed-timeline.ts', 'collapseTerminalChains'],
      ['structure-layout.ts', 'computeStructureLayout'],
      ['mission-task-strip.ts', 'stripOrder'],
    ] as const) {
      expect(body(file, fn)).not.toContain('.dependsOn');
    }
  });
  it('the progress bar compacts by state in one place', () => {
    const bar = src('../components/MissionProgressBar.tsx');
    expect(bar.split('{ solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 }').length - 1).toBeLessThanOrEqual(1);
  });
});
