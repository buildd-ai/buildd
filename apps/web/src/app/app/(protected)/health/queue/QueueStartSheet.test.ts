/**
 * A Blocked row's start (spec 4bc3e70e r8 R-20, AC-13): what the server
 * accepted is said as requested, never as running, until a runner claims it.
 */
import { describe, expect, it } from 'bun:test';
import { startStatusLine } from './QueueStartSheet';

const forced = (gates: string[]) => ({ forceId: 'f', gates, railsRemaining: [], expiresAt: '2026-10-25T12:00:00Z' });

describe('startStatusLine', () => {
  it('Start anyway on a dependency reads requested, then waiting for a claim', () => {
    expect(startStatusLine({ status: 'waiting', forced: forced(['Declared dependency']) })).toBe('Start anyway requested.');
    expect(startStatusLine({ status: 'queued', forced: forced(['Declared dependency']) })).toBe('Start anyway requested. Waiting for a runner to claim it.');
  });

  it('Force start on a limit reads Force start requested', () => {
    expect(startStatusLine({ status: 'waiting', forced: forced(['Mission concurrency limit']) })).toBe('Force start requested.');
  });

  it('only a claim reads as taken; a refusal or idle says nothing', () => {
    expect(startStatusLine({ status: 'accepted', forced: null })).toBe('Claimed by a runner');
    expect(startStatusLine({ status: 'gated', forced: null })).toBeNull();
    expect(startStatusLine({ status: 'idle', forced: null })).toBeNull();
  });
});
