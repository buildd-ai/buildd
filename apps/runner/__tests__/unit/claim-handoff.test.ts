import { describe, it, expect } from 'bun:test';
import { ClaimHandoffTracker } from '../../src/claim-handoff';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ClaimHandoffTracker', () => {
  it('reports a claim in flight until its response is read', async () => {
    const t = new ClaimHandoffTracker();
    const d = deferred<{ workers: Array<{ id: string }> }>();
    const call = t.track(() => d.promise);
    expect(t.snapshot()).toEqual({ pendingStartIds: [], claimInFlight: true });
    d.resolve({ workers: [{ id: 'w-1' }] });
    await call;
    // Received but not started: held as pending, no longer in flight.
    expect(t.snapshot()).toEqual({ pendingStartIds: ['w-1'], claimInFlight: false });
  });

  it('a timed-out claim (lost response) leaves nothing held, so the server may release what it minted', async () => {
    const t = new ClaimHandoffTracker();
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    await expect(t.track(() => Promise.reject(timeout))).rejects.toThrow('timed out');
    expect(t.snapshot()).toEqual({ pendingStartIds: [], claimInFlight: false });
  });

  it('stays in flight while any of two concurrent polls is outstanding', async () => {
    const t = new ClaimHandoffTracker();
    const a = deferred<{ workers: [] }>();
    const b = deferred<{ workers: [] }>();
    const ca = t.track(() => a.promise);
    const cb = t.track(() => b.promise);
    a.resolve({ workers: [] });
    await ca;
    expect(t.snapshot().claimInFlight).toBe(true);
    b.resolve({ workers: [] });
    await cb;
    expect(t.snapshot().claimInFlight).toBe(false);
  });

  it('settle drops a worker once it is started (or its failure reported)', async () => {
    const t = new ClaimHandoffTracker();
    await t.track(async () => ({ workers: [{ id: 'w-1' }, { id: 'w-2' }] }));
    t.settle('w-1');
    expect(t.snapshot().pendingStartIds).toEqual(['w-2']);
    t.settle('w-1'); // duplicate settle is harmless
    expect(t.snapshot().pendingStartIds).toEqual(['w-2']);
  });

  it('a fresh tracker (runner restart) holds nothing from the previous process', () => {
    expect(new ClaimHandoffTracker().snapshot()).toEqual({ pendingStartIds: [], claimInFlight: false });
  });
});
