import { describe, it, expect, mock } from 'bun:test';

/**
 * `computePlanPhases` is the whole of Rule P1-4/P1-9: it decides which of a
 * plan's steps belong to which named stretch of the mission, and it is the only
 * thing that ever writes `tasks.mission_phase_*` for a plan.
 *
 * The db import is stubbed because this file only exercises the pure half —
 * `inheritPhaseFromParent` is covered through its call sites.
 */
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: () => Promise.resolve(undefined) } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'tasks.id' } }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b }) }));

import { computePlanPhases } from './mission-phase';

describe('computePlanPhases — a phase is a heading, not a tag', () => {
  it('AC-2: four distinct labels across nine steps become indexes 1–4 in plan order', () => {
    const plan = [
      { phase: 'Storage' }, { phase: 'Storage' },
      { phase: 'Population' }, { phase: 'Population' }, { phase: 'Population' },
      { phase: 'Rendering' }, { phase: 'Rendering' },
      { phase: 'Rollout' }, { phase: 'Rollout' },
    ];
    expect(computePlanPhases(plan).map(p => p.missionPhaseIndex)).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4]);
    expect(computePlanPhases(plan)[4].missionPhaseLabel).toBe('Population');
  });

  it('an unlabelled step between two labelled ones inherits the OPEN phase', () => {
    const phases = computePlanPhases([
      { phase: 'Storage' },
      {},                       // governed by the heading above it
      {},
      { phase: 'Rendering' },
      {},
    ]);
    expect(phases.map(p => p.missionPhaseIndex)).toEqual([1, 1, 1, 2, 2]);
    expect(phases.map(p => p.missionPhaseLabel)).toEqual(['Storage', 'Storage', 'Storage', 'Rendering', 'Rendering']);
  });

  it('a step BEFORE the first labelled step belongs to no phase', () => {
    const phases = computePlanPhases([{}, { phase: 'Storage' }, {}]);
    expect(phases[0]).toEqual({ missionPhaseIndex: null, missionPhaseLabel: null });
    expect(phases[1].missionPhaseIndex).toBe(1);
  });

  it('a label that re-appears after a different one opens a NEW index, not the old one', () => {
    // Plan order is the contract; a returning label is a returning stretch of
    // work, not a retroactive member of the earlier band.
    const phases = computePlanPhases([{ phase: 'A' }, { phase: 'B' }, { phase: 'A' }]);
    expect(phases.map(p => p.missionPhaseIndex)).toEqual([1, 2, 3]);
  });

  it('blank and whitespace-only labels are not labels', () => {
    const phases = computePlanPhases([{ phase: '   ' }, { phase: '' }]);
    expect(phases.every(p => p.missionPhaseIndex === null)).toBe(true);
  });

  it('AC-3 (rejection): a plan with no labels stores nothing at all', () => {
    const phases = computePlanPhases([
      { }, { }, { },
    ] as Array<{ phase?: string }>);
    expect(phases).toEqual([
      { missionPhaseIndex: null, missionPhaseLabel: null },
      { missionPhaseIndex: null, missionPhaseLabel: null },
      { missionPhaseIndex: null, missionPhaseLabel: null },
    ]);
  });

  it('Rule P1-9: an unlabelled plan raised inside a phase keeps its children in it', () => {
    const phases = computePlanPhases(
      [{}, {}],
      { missionPhaseIndex: 3, missionPhaseLabel: 'Rendering' },
    );
    expect(phases).toEqual([
      { missionPhaseIndex: 3, missionPhaseLabel: 'Rendering' },
      { missionPhaseIndex: 3, missionPhaseLabel: 'Rendering' },
    ]);
  });

  it('a plan that DOES declare phases ignores the planning task\'s own phase', () => {
    // The plan's own structure is the more specific statement; inheriting on top
    // of it would renumber a plan that already said what its phases are.
    const phases = computePlanPhases(
      [{ phase: 'Storage' }, { phase: 'Rendering' }],
      { missionPhaseIndex: 3, missionPhaseLabel: 'Rendering' },
    );
    expect(phases.map(p => p.missionPhaseIndex)).toEqual([1, 2]);
  });

  it('a half-set inherited phase is treated as no phase (the column pair is all-or-nothing)', () => {
    expect(computePlanPhases([{}], { missionPhaseIndex: 3, missionPhaseLabel: null }))
      .toEqual([{ missionPhaseIndex: null, missionPhaseLabel: null }]);
    expect(computePlanPhases([{}], { missionPhaseIndex: null, missionPhaseLabel: 'Rendering' }))
      .toEqual([{ missionPhaseIndex: null, missionPhaseLabel: null }]);
  });

  it('never derives a phase from step count, ordering depth, or title text', () => {
    // Nine steps with dependsOn layering and BUILD:/REVIEW: prefixes — every
    // signal Rule P1-5 and P1-6 reject — and no `phase` anywhere.
    const plan = [
      { ref: 'a', title: 'SPEC: x' },
      { ref: 'b', title: 'BUILD: x', dependsOn: ['a'] },
      { ref: 'c', title: 'REVIEW: x', dependsOn: ['b'] },
    ] as Array<{ phase?: string }>;
    expect(computePlanPhases(plan).every(p => p.missionPhaseIndex === null)).toBe(true);
  });
});
