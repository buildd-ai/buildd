import { describe, expect, it, mock } from 'bun:test';
import { createRegionReader } from './region-reader';
import { createPageRefreshGate } from './page-refresh';
import type { Clock } from './realtime-throttle';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function fakeClock() {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  } as Clock;
  return { clock, advance(ms: number) { t += ms; for (const h of timers.filter(x => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn(); } } };
}

describe('createRegionReader', () => {
  it('applies the read value', async () => {
    const apply = mock(() => {});
    const fallback = mock(() => {});
    const r = createRegionReader({ load: async () => 'fresh', apply, fallback });
    r.refresher.refresh();
    await tick();
    expect(apply).toHaveBeenCalledWith('fresh');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to a page refresh when the read is empty or throws', async () => {
    const fallback = mock(() => {});
    const empty = createRegionReader({ load: async () => null, apply: () => {}, fallback });
    empty.refresher.refresh();
    await tick();
    const boom = createRegionReader({ load: async () => { throw new Error('stale action'); }, apply: () => {}, fallback });
    const err = console.error;
    console.error = () => {};
    boom.refresher.refresh();
    await tick();
    console.error = err;
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('drops an ask while a read is in flight', async () => {
    let release: (v: string) => void = () => {};
    const load = mock(() => new Promise<string>(res => { release = res; }));
    const apply = mock(() => {});
    const r = createRegionReader({ load, apply, fallback: () => {} });
    r.refresher.refresh();
    r.refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    release('x');
    await tick();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('discards a read superseded by a newer render', async () => {
    let release: (v: string) => void = () => {};
    const apply = mock(() => {});
    const r = createRegionReader({ load: () => new Promise<string>(res => { release = res; }), apply, fallback: () => {} });
    r.refresher.refresh();
    r.supersede();
    release('stale');
    await tick();
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps the 5 s cap: a burst of asks through the gate is one read per window', async () => {
    const { clock, advance } = fakeClock();
    const gate = createPageRefreshGate(clock, 5_000);
    const load = mock(async () => 'v');
    const r = createRegionReader({ load, apply: () => {}, fallback: () => {} });
    for (let i = 0; i < 20; i++) gate.request(r.refresher);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) { advance(200); gate.request(r.refresher); }
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    advance(5_000);
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
