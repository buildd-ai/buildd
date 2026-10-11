import { describe, it, expect } from 'bun:test';
import { describeCreatedTaskState } from '../mcp-tools';

describe('describeCreatedTaskState', () => {
  it('defaults to a positive async line without negative claim wording', () => {
    const s = describeCreatedTaskState({ status: 'pending' });
    expect(s).toBe('Created and queued; pickup is asynchronous');
    expect(s).not.toMatch(/no runner|next poll|Cloudflare/i);
  });

  it('does not report an undelivered wake as dispatched or delivered', () => {
    const s = describeCreatedTaskState({ status: 'pending', dispatch: { status: 'pending' } });
    expect(s).toContain('wake not yet delivered');
    expect(s).not.toMatch(/handed off|wake delivered/);
  });

  it('never implies a container started from a hand-off alone', () => {
    const s = describeCreatedTaskState({ status: 'pending', dispatch: { status: 'handed_off' } });
    expect(s).toContain('not yet confirmed delivered');
    expect(s).not.toMatch(/started|running|claimed/i);
  });

  it('reports a delivered wake as not a claim', () => {
    const s = describeCreatedTaskState({ status: 'pending', dispatch: { status: 'delivered', deliveredAt: 'x', deliveredVia: 'webhook' } });
    expect(s).toContain('wake delivered via webhook');
    expect(s).toContain('not a claim');
  });

  it('names a grounded path_overlap blocker', () => {
    const s = describeCreatedTaskState({ status: 'pending', blockedByPr: { prNumber: 3995 }, deferral: { reason: 'path_overlap', blockingTaskId: 'abc12345' } });
    expect(s).toContain('path_overlap');
    expect(s).toContain('PR #3995');
    expect(s).toContain('task abc12345');
  });

  it('keeps claimed and scheduled states', () => {
    expect(describeCreatedTaskState({ status: 'assigned' })).toContain('Claimed');
    expect(describeCreatedTaskState({ status: 'pending', startAt: '2030-01-01T00:00:00Z' })).toContain('Deferred until 2030-01-01');
  });
});
