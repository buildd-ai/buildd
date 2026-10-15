import { describe, expect, it } from 'bun:test';
import { timedSteps } from './cron-step-timing';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('timedSteps', () => {
  it('logs each step as it settles, with its name, and keeps the results in order', async () => {
    const lines: string[] = [];
    const out = await Promise.all(
      timedSteps('T', ['slow', 'fast'], [wait(30).then(() => 'a'), Promise.resolve('b')] as const, { log: l => lines.push(l) }),
    );
    expect(out).toEqual(['a', 'b']);
    expect(lines[0]).toMatch(/^\[T\] step=fast ms=\d+$/);
    expect(lines[1]).toMatch(/^\[T\] step=slow ms=\d+$/);
  });

  it('logs a failing step and still rejects with its error', async () => {
    const lines: string[] = [];
    const [p] = timedSteps('T', ['boom'], [Promise.reject(new Error('x'))] as const, { log: l => lines.push(l) });
    await expect(p).rejects.toThrow('x');
    expect(lines).toEqual([expect.stringMatching(/^\[T\] step=boom ms=\d+$/)]);
  });

  it('names the steps still running when the watchdog fires', async () => {
    const lines: string[] = [];
    const steps = timedSteps('T', ['stuck', 'done'], [wait(60), Promise.resolve(1)] as const, { stallAfterMs: 20, log: l => lines.push(l) });
    await Promise.all(steps);
    expect(lines.some(l => /^\[T\] still running after \d+ms: stuck$/.test(l))).toBe(true);
  });

  it('does not fire the watchdog when every step settled in time', async () => {
    const lines: string[] = [];
    await Promise.all(timedSteps('T', ['a'], [Promise.resolve(1)] as const, { stallAfterMs: 10, log: l => lines.push(l) }));
    await wait(30);
    expect(lines.some(l => l.includes('still running'))).toBe(false);
  });
});
