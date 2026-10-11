import { describe, expect, it } from 'bun:test';
import { buildHistory, nestDay } from './mission-history';
import type { FeedDay, FeedEvent } from './mission-event-feed';

const ev = (id: string, kind: FeedEvent['kind'], taskId: string | null, nest = false): FeedEvent =>
  ({ id, kind, at: 0, time: '09:00', actor: 'a', detail: id, taskId, nest });

const day = (events: FeedEvent[]): FeedDay => ({ key: '2026-01-01', label: 'Jan 1', quietDays: 0, events });

describe('nestDay', () => {
  it('puts a retry and a CI failure under their task’s earlier entry', () => {
    const entries = nestDay([ev('claim', 'claim', 't1'), ev('ci', 'failed', 't1', true), ev('retry', 'claim', 't1', true), ev('other', 'claim', 't2')]);
    expect(entries.map(e => e.event.id)).toEqual(['claim', 'other']);
    expect(entries[0].children.map(c => c.id)).toEqual(['ci', 'retry']);
  });

  it('leaves a nested event top-level when its task has no earlier entry that day', () => {
    expect(nestDay([ev('ci', 'failed', 't1', true)]).map(e => e.event.id)).toEqual(['ci']);
  });
});

describe('buildHistory', () => {
  const days = [day([ev('claim', 'claim', 't1'), ev('ci', 'failed', 't1', true), ev('pr', 'pr', 't1'), ev('merged', 'merged', 't1')])];

  it('Everything keeps one entry per event, nested under the parent', () => {
    const h = buildHistory(days, 'everything');
    expect(h[0].entries.map(e => e.event.id)).toEqual(['claim', 'pr', 'merged']);
    expect(h[0].count).toBe(4);
  });

  it('Changes drops claims, and a repair surfaces when its parent is hidden', () => {
    const h = buildHistory(days, 'changes');
    expect(h[0].entries.map(e => e.event.id)).toEqual(['ci', 'pr', 'merged']);
    expect(h[0].count).toBe(3);
  });

  it('Changes drops a day with nothing in it', () => {
    expect(buildHistory([day([ev('claim', 'claim', 't1'), ev('plan', 'plan', null)])], 'changes')).toEqual([]);
  });
});
