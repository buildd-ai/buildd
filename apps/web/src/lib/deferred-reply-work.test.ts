import { describe, expect, it } from 'bun:test';
import { deferredReplyWork } from './deferred-reply-work';

/** An `after()` that holds its callbacks so a test decides when the reply "closes". */
function fakeAfter() {
  const callbacks: Array<() => Promise<unknown>> = [];
  return {
    after: (cb: () => Promise<unknown>) => { callbacks.push(cb); },
    callbacks,
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('deferredReplyWork', () => {
  it('runs every item queued in one request, in order', async () => {
    const f = fakeAfter();
    const afterReply = deferredReplyWork({ after: f.after });
    const ran: string[] = [];
    await afterReply('a', async () => { ran.push('a'); });
    await afterReply('b', async () => { ran.push('b'); });
    expect(f.callbacks).toHaveLength(1);
    await f.callbacks[0]();
    expect(ran).toEqual(['a', 'b']);
  });

  // The v0.367.0 loss: the drain started while the handler was still queueing,
  // so an item pushed after the first one had begun was never run.
  it('runs an item queued while the drain is already running', async () => {
    const f = fakeAfter();
    const afterReply = deferredReplyWork({ after: f.after });
    const ran: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    await afterReply('first', async () => { await held; ran.push('first'); });
    const draining = f.callbacks[0]();
    await tick();
    await afterReply('verdict', async () => { ran.push('verdict'); });
    release();
    await draining;
    await Promise.all(f.callbacks.slice(1).map(cb => cb()));
    expect(ran).toEqual(['first', 'verdict']);
  });

  it('runs an item queued after the drain finished', async () => {
    const f = fakeAfter();
    const afterReply = deferredReplyWork({ after: f.after });
    const ran: string[] = [];
    await afterReply('first', async () => { ran.push('first'); });
    await f.callbacks[0]();
    await afterReply('late', async () => { ran.push('late'); });
    await Promise.all(f.callbacks.slice(1).map(cb => cb()));
    expect(ran).toEqual(['first', 'late']);
  });

  it('runs inline where there is no request (after throws)', async () => {
    const afterReply = deferredReplyWork({ after: () => { throw new Error('outside a request scope'); } });
    const ran: string[] = [];
    await afterReply('a', async () => { ran.push('a'); });
    await afterReply('b', async () => { ran.push('b'); });
    expect(ran).toEqual(['a', 'b']);
  });

  it('a failing item does not stop the ones after it', async () => {
    const f = fakeAfter();
    const afterReply = deferredReplyWork({ after: f.after });
    const ran: string[] = [];
    await afterReply('boom', async () => { throw new Error('boom'); });
    await afterReply('next', async () => { ran.push('next'); });
    await f.callbacks[0]();
    expect(ran).toEqual(['next']);
  });
});
