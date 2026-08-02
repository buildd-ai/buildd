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
