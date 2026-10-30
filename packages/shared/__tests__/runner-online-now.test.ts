import { describe, it, expect } from 'bun:test';
import { runnerOnlineNow, RUNNER_LIVE_WINDOW_MS, RUNNER_PRESENCE_BEAT_WINDOW_MS, RUNNER_FALLBACK_PING_MS } from '../src/runner-liveness';

const now = 10_000_000_000;
const ago = (ms: number) => new Date(now - ms);

describe('runnerOnlineNow', () => {
  it('connected and fresh content beat: online', () => {
    expect(runnerOnlineNow(ago(RUNNER_FALLBACK_PING_MS), true, now)).toBe(true);
  });
  it('connected but beat stale past the fallback window: offline', () => {
    expect(runnerOnlineNow(ago(RUNNER_PRESENCE_BEAT_WINDOW_MS + 1), true, now)).toBe(false);
  });
  it('presence removed with a fresh beat: offline', () => {
    expect(runnerOnlineNow(ago(1_000), false, now)).toBe(false);
  });
  it('no presence record, fresh 60s beat (old runner): online by the beat-only window', () => {
    expect(runnerOnlineNow(ago(RUNNER_LIVE_WINDOW_MS - 1), null, now)).toBe(true);
    expect(runnerOnlineNow(ago(RUNNER_LIVE_WINDOW_MS - 1), undefined, now)).toBe(true);
  });
  it('no presence record, beat past the beat-only window: offline', () => {
    expect(runnerOnlineNow(ago(RUNNER_LIVE_WINDOW_MS + 1), null, now)).toBe(false);
  });
});
