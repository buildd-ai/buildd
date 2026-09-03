import { describe, it, expect } from 'bun:test';

import {
  waitForPrReviewStatus,
} from './pr-review-request';
import { MAX_REVIEW_WAIT_SECONDS, REVIEW_POLL_INTERVAL_MS } from './pr-review-status';

describe('waitForPrReviewStatus', () => {
  function statusAt(state: string, terminal: boolean) {
    return { state, terminal } as any;
  }

  it('returns immediately when the state is already terminal', async () => {
    const reads: number[] = [];
    const slept: number[] = [];
    const result = await waitForPrReviewStatus({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 30,
      deps: {
        read: async () => {
          reads.push(1);
          return statusAt('approved', true);
        },
        sleep: async (ms: number) => { slept.push(ms); },
      },
    });

    expect(result.timedOut).toBe(false);
    expect(result.status.state).toBe('approved');
    expect(reads).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  it('polls until the state turns terminal', async () => {
    const states = [
      statusAt('queued', false),
      statusAt('reviewing', false),
      statusAt('approved', true),
    ];
    let i = 0;
    const slept: number[] = [];
    const result = await waitForPrReviewStatus({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 30,
      deps: {
        read: async () => states[i++]!,
        sleep: async (ms: number) => { slept.push(ms); },
      },
    });

    expect(result.status.state).toBe('approved');
    expect(result.timedOut).toBe(false);
    expect(slept).toHaveLength(2);
    expect(slept[0]).toBe(REVIEW_POLL_INTERVAL_MS);
  });

  it('gives up at the deadline and says so instead of hanging', async () => {
    let now = 0;
    const result = await waitForPrReviewStatus({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 6,
      deps: {
        read: async () => statusAt('reviewing', false),
        sleep: async (ms: number) => { now += ms; },
        now: () => now,
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.status.state).toBe('reviewing');
    // A caller that re-calls must not have waited longer than it asked for.
    expect(now).toBeLessThanOrEqual(6_000);
  });

  it('clamps the wait below the serverless function limit', async () => {
    let now = 0;
    const result = await waitForPrReviewStatus({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 600,
      deps: {
        read: async () => statusAt('reviewing', false),
        sleep: async (ms: number) => { now += ms; },
        now: () => now,
      },
    });

    expect(result.timedOut).toBe(true);
    expect(now).toBeLessThanOrEqual(MAX_REVIEW_WAIT_SECONDS * 1000);
  });

  it('a zero wait is a single read — the plain poll path', async () => {
    let reads = 0;
    const result = await waitForPrReviewStatus({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 0,
      deps: {
        read: async () => { reads++; return statusAt('reviewing', false); },
        sleep: async () => { throw new Error('must not sleep on a zero wait'); },
      },
    });
    expect(reads).toBe(1);
    expect(result.timedOut).toBe(true);
  });
});
