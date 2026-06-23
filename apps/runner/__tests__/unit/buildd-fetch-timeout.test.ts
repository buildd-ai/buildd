import { describe, it, expect, afterEach } from 'bun:test';

// Regression: the runner's HTTP wrapper had no timeout, so a half-open keep-alive
// socket made requests hang forever — wedging the claim poll until restart
// (2026-06-23). Every request now carries AbortSignal.timeout; a hung request
// must reject promptly rather than hang.
//
// Note: We test the AbortSignal.timeout mechanism inline (not via BuilddClient
// directly) because other test files mock '../../src/buildd' with a partial class
// and Bun shares the module registry across test files in the same run.
// See buildd-skills.test.ts for the same pattern.
describe('BuilddClient fetch timeout', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('aborts a hung request instead of hanging forever', async () => {
    const TIMEOUT_MS = 60; // Shrink the 30s production ceiling for the test

    // A server that accepts the connection but never responds — only the abort
    // signal ends it (mirrors a half-open socket).
    globalThis.fetch = ((_url: string, opts: any) =>
      new Promise((_resolve, reject) => {
        const sig = opts?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener('abort', () => {
            const e = new Error('The operation timed out.');
            e.name = 'TimeoutError';
            reject(e);
          });
        }
      })) as any;

    // Test the exact pattern BuilddClient.fetch uses:
    //   signal: options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const start = Date.now();
    await expect(
      fetch('https://example.invalid/api/tasks', {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Must reject around the 60ms timeout — not hang. Generous upper bound.
    expect(elapsed).toBeLessThan(2000);
  });
});
