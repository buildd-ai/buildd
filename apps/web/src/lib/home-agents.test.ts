import { describe, expect, test } from 'bun:test';
import type { FleetSnapshot } from '@buildd/shared';
import { agentsSummary, buildAgentsModel, elapsedLabel, homeHeadlineSentence, homeSubline } from './home-agents';

const slot = (index: number, worker: Record<string, unknown> | null) => ({ index, worker, last: null, lane: { id: String(index), bars: [] } });
const worker = (id: string, over: Record<string, unknown> = {}) => ({
  workerId: id, taskId: `t-${id}`, missionId: 'm1', label: 'db', rest: 'add index', roleSlug: 'builder', roleName: 'Builder', roleColor: null,
  status: 'running', progress: null, startedAt: new Date(0).toISOString(), question: null, ...over,
});
const fleet = (slots: unknown[], capacity: number): FleetSnapshot => ({
  runners: [{ id: 'r', name: 'box', machine: null, maxSlots: capacity, online: true, slots }],
  live: 0, capacity, window: { from: 0, to: 0 },
} as unknown as FleetSnapshot);

describe('buildAgentsModel', () => {
  test('one square per slot: busy, waiting on a person, free', () => {
    const m = buildAgentsModel(fleet([slot(0, worker('a')), slot(1, worker('b', { question: 'ok?' })), slot(2, null), slot(3, worker('c'))], 4), 40 * 60_000, new Map([['m1', 'Ship it']]));
    expect(m.squares).toEqual(['busy', 'waiting', 'free', 'busy']);
    expect(agentsSummary(m)).toBe('3 of 4 busy');
    expect(m.lines).toHaveLength(3);
    expect(m.lines[0]).toMatchObject({ name: 'db', mission: 'Ship it', elapsedMs: 40 * 60_000 });
  });

  test('capacity beyond the drawn slots stays free', () => {
    expect(buildAgentsModel(fleet([slot(0, null)], 3), 0).squares).toEqual(['free', 'free', 'free']);
  });

  test('offline runners add no squares', () => {
    const f = fleet([slot(0, worker('a'))], 0);
    f.runners[0].online = false;
    expect(buildAgentsModel(f, 0).squares).toEqual([]);
  });
});

describe('copy', () => {
  test('headline and sub-line', () => {
    expect(homeHeadlineSentence(3)).toBe('3 decisions need you.');
    expect(homeHeadlineSentence(1)).toBe('1 decision needs you.');
    expect(homeHeadlineSentence(0)).toBe('All clear. Nothing needs you.');
    expect(homeSubline(0, 0)).toBe('No other action needed.');
    expect(homeSubline(0, 1)).toBe('1 automatic repair is running.');
    expect(homeSubline(2, 3)).toBe('3 automatic repairs are running.');
  });
  // The voice review flagged "Everything else is moving on its own." as narration.
  test('the sub-line with decisions open is the same plain line', () => {
    expect(homeSubline(2, 0)).toBe('No other action needed.');
  });
  test('elapsed', () => {
    expect(elapsedLabel(38 * 60_000)).toBe('38m');
    expect(elapsedLabel(65 * 60_000)).toBe('1h 05m');
  });
});
