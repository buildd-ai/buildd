import { describe, expect, it } from 'bun:test';
import { buildTickerEvents, type TickerWorkerRow } from './home-ticker';

const T0 = Date.UTC(2026, 0, 10, 14, 0);
const at = (m: number) => new Date(T0 + m * 60_000);
const task = (id: string, title = `feat(${id}): something`) => ({ id: `t-${id}`, title, missionId: 'm1' });

describe('buildTickerEvents', () => {
  const workers: TickerWorkerRow[] = [
    { id: 'w1', status: 'completed', startedAt: at(1), completedAt: at(8), mergedAt: at(10), prNumber: 412, linesAdded: 142, linesRemoved: 97, runnerName: 'atlas', task: task('money') },
    { id: 'w2', status: 'waiting_input', startedAt: at(11), updatedAt: at(14), runnerName: 'dune', task: task('checkout') },
  ];
  const events = buildTickerEvents(workers, [{ id: 'm9', title: 'Example', completedAt: at(15) }]);

  it('one glyph row per event, newest first, no prose', () => {
    expect(events.map(e => [e.kind, e.label, e.right])).toEqual([
      ['mission', 'mission', 'mission done'],
      ['question', 'question', 'asks you'],
      ['claim', 'checkout', 'claimed'],
      ['merged', '#412', 'merged'],
      ['pr', '#412', '+142 −97'],
      ['claim', 'money', 'claimed'],
    ]);
    expect(events.find(e => e.kind === 'claim')?.detail).toBe('→ dune');
    for (const e of events) expect(`${e.label} ${e.detail} ${e.right}`).not.toContain('via ');
  });

  it('links task rows into the mission, never to a bare task page', () => {
    expect(events.find(e => e.kind === 'merged')?.href).toStartWith('/app/missions/m1?');
  });

  it('collapses identical consecutive rows (heartbeat ticks) into one with a count', () => {
    const ticks: TickerWorkerRow[] = [0, 1, 2].map(i => ({
      id: `hb${i}`, status: 'completed', startedAt: at(i), completedAt: at(i), runnerName: 'dune',
      task: { id: `hb${i}`, title: 'Mission: Keep dependencies current', mode: 'planning', missionId: 'm2' },
    }));
    const rows = buildTickerEvents(ticks, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'plan', count: 3 });
  });

  it('respects the window and the limit', () => {
    expect(buildTickerEvents(workers, [], { since: T0 + 9 * 60_000 }).every(e => e.at >= T0 + 9 * 60_000)).toBe(true);
    expect(buildTickerEvents(workers, [], { limit: 2 })).toHaveLength(2);
  });
});
