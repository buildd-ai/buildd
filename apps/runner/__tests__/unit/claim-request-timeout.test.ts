import { afterEach, expect, it } from 'bun:test';
import { BuilddClient } from '../../src/buildd';

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; });

it('waits beyond the ordinary request ceiling for a claim, but still aborts a hung claim', async () => {
  const deadlines: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    deadlines.push(ms);
    return realTimeout.call(AbortSignal, ms / 1000);
  }) as typeof AbortSignal.timeout;
  let hung = false;
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = hung ? undefined : setTimeout(() => resolve(Response.json({ workers: [{ id: 'worker' }] })), 50);
    init.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const client = new BuilddClient({ builddServer: 'https://example.invalid', apiKey: 'test' } as any);
  expect((await client.claimTask()).workers).toEqual([{ id: 'worker' }]);
  expect(deadlines[0]).toBe(90_000);
  hung = true;
  await expect(client.claimTask()).rejects.toThrow();
});
