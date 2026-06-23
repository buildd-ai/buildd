import { describe, it, expect, beforeAll, afterEach } from 'bun:test';

// Regression: the runner's HTTP wrapper had no timeout, so a half-open keep-alive
// socket made requests hang forever — wedging the claim poll until restart
// (2026-06-23). Every request now carries AbortSignal.timeout; a hung request
// must reject promptly rather than hang.
describe('BuilddClient fetch timeout', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BuilddClient: any;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.BUILDD_FETCH_TIMEOUT_MS = '60'; // shrink the 30s ceiling for the test
    ({ BuilddClient } = await import('../../src/buildd'));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('aborts a hung request instead of hanging forever', async () => {
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

    const client = new BuilddClient({ builddServer: 'https://example.invalid', apiKey: 'bld_test', localUiUrl: '' } as any);

    const start = Date.now();
    await expect(client.listTasks()).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Must reject around the 60ms timeout — not hang. Generous upper bound.
    expect(elapsed).toBeLessThan(2000);
  });
});
