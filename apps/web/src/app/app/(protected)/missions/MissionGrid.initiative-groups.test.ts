/**
 * TDD tests for initiative grouping logic in the Missions list.
 * Tests the pure groupMissionsByInitiative function which drives
 * the I-3 collapsible initiative group headers feature.
 *
 * Safety invariant: no mission may disappear due to grouping logic.
 */
import { describe, it, expect } from 'bun:test';
import { groupMissionsByInitiative } from './MissionGrid';

type MinM = { id: string; initiativeId: string | null };
const m = (id: string, initiativeId: string | null): MinM => ({ id, initiativeId });

describe('groupMissionsByInitiative', () => {
  it('groups missions under their initiative', () => {
    const missions = [m('m1', 'i1'), m('m2', 'i1'), m('m3', 'i2')];
    const { byInitiative, ungrouped } = groupMissionsByInitiative(missions, ['i1', 'i2']);
    expect(byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m1', 'm2']);
    expect(byInitiative.get('i2')?.map((x) => x.id)).toEqual(['m3']);
    expect(ungrouped).toHaveLength(0);
  });

  it('puts missions with no initiativeId into ungrouped', () => {
    const missions = [m('m1', null), m('m2', 'i1')];
    const { byInitiative, ungrouped } = groupMissionsByInitiative(missions, ['i1']);
    expect(ungrouped.map((x) => x.id)).toEqual(['m1']);
    expect(byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m2']);
  });

  it('puts missions with unknown initiativeId into ungrouped (safety guard)', () => {
    // Mission points to an initiative not in the known list (e.g., archived initiative).
    // Must not disappear.
    const missions = [m('m1', 'deleted-or-archived-init'), m('m2', 'i1')];
    const { byInitiative, ungrouped } = groupMissionsByInitiative(missions, ['i1']);
    expect(ungrouped.map((x) => x.id)).toEqual(['m1']);
    expect(byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m2']);
  });

  it('accounts for every mission — no mission disappears', () => {
    const missions = [m('m1', 'i1'), m('m2', null), m('m3', 'unknown-init')];
    const { byInitiative, ungrouped } = groupMissionsByInitiative(missions, ['i1']);
    const allMapped = [...byInitiative.values()].flat().concat(ungrouped);
    expect(allMapped).toHaveLength(missions.length);
    expect(allMapped.map((x) => x.id).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns empty array for initiative with no missions in current view', () => {
    const missions = [m('m1', 'i1')];
    const { byInitiative } = groupMissionsByInitiative(missions, ['i1', 'i2']);
    expect(byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m1']);
    expect(byInitiative.get('i2')).toEqual([]);
  });

  it('handles all-ungrouped missions when no initiative IDs given', () => {
    const missions = [m('m1', null), m('m2', null)];
    const { byInitiative, ungrouped } = groupMissionsByInitiative(missions, []);
    expect(byInitiative.size).toBe(0);
    expect(ungrouped.map((x) => x.id)).toEqual(['m1', 'm2']);
  });

  it('handles empty mission list', () => {
    const { byInitiative, ungrouped } = groupMissionsByInitiative([], ['i1']);
    expect(byInitiative.get('i1')).toEqual([]);
    expect(ungrouped).toHaveLength(0);
  });
});

describe('count conservation — rendered mission count === fetched mission count', () => {
  function totalCount<T>(result: { byInitiative: Map<string, T[]>; ungrouped: T[] }): number {
    return [...result.byInitiative.values()].flat().length + result.ungrouped.length;
  }

  it('zero initiatives: all missions land in ungrouped', () => {
    const missions = [m('m1', null), m('m2', null)];
    const result = groupMissionsByInitiative(missions, []);
    expect(totalCount(result)).toBe(missions.length);
    expect(result.ungrouped).toHaveLength(2);
    expect(result.byInitiative.size).toBe(0);
  });

  it('all-ungrouped (no matching initiativeId): no mission disappears', () => {
    const missions = [m('m1', null), m('m2', null), m('m3', null)];
    const result = groupMissionsByInitiative(missions, ['i1']);
    expect(totalCount(result)).toBe(missions.length);
    expect(result.ungrouped).toHaveLength(3);
    expect(result.byInitiative.get('i1')).toHaveLength(0);
  });

  it('initiativeId pointing at non-existent initiative goes to Other (ungrouped)', () => {
    const missions = [m('m1', 'ghost-archived-init'), m('m2', 'i1')];
    const result = groupMissionsByInitiative(missions, ['i1']);
    expect(totalCount(result)).toBe(missions.length);
    expect(result.ungrouped.map((x) => x.id)).toEqual(['m1']);
    expect(result.byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m2']);
  });

  it('fully grouped: ungrouped is empty', () => {
    const missions = [m('m1', 'i1'), m('m2', 'i2')];
    const result = groupMissionsByInitiative(missions, ['i1', 'i2']);
    expect(totalCount(result)).toBe(missions.length);
    expect(result.ungrouped).toHaveLength(0);
  });

  it('mixed permutation: null + unknown + valid all conserved', () => {
    const missions = [m('m1', 'i1'), m('m2', null), m('m3', 'ghost-init'), m('m4', 'i2')];
    const result = groupMissionsByInitiative(missions, ['i1', 'i2']);
    expect(totalCount(result)).toBe(missions.length);
    expect(result.ungrouped.map((x) => x.id).sort()).toEqual(['m2', 'm3']);
    expect(result.byInitiative.get('i1')?.map((x) => x.id)).toEqual(['m1']);
    expect(result.byInitiative.get('i2')?.map((x) => x.id)).toEqual(['m4']);
  });

  it('empty mission input: total is zero regardless of initiatives', () => {
    const result = groupMissionsByInitiative([], ['i1', 'i2', 'i3']);
    expect(totalCount(result)).toBe(0);
    expect(result.ungrouped).toHaveLength(0);
  });
});
