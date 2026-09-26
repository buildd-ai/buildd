import { describe, expect, it } from 'bun:test';
import type { Clock } from '@/lib/realtime-throttle';
import type { BuilddObjectRef } from '../chat-contract';
import { createObjectStore, type ObjectSource } from './object-store';
import type { TaskObjectView } from './object-views';

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    advance(ms) {
      t += ms;
      for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn(); }
    },
  };
}

const ref: BuilddObjectRef = { kind: 'task', id: 't1', workspaceId: 'ws', fallbackText: 'task' };
const view = (status: string): TaskObjectView => ({
  kind: 'task', id: 't1', workspaceId: 'ws', title: 'feat(api): x', scope: 'api', label: 'x', status,
  roleName: null, roleColor: null, missionId: 'm1', missionTitle: null, worker: null, renderedAt: 0,
});
const flush = () => new Promise(r => setTimeout(r, 0));

function harness() {
  let loads = 0;
  let status = 'pending';
  let emit: ((e: string, d: unknown) => void) | null = null;
  let watching = 0;
  const source: ObjectSource = {
    load: async () => { loads += 1; return view(status); },
    watch: (_r, _v, e) => { emit = e; watching += 1; return () => { watching -= 1; emit = null; }; },
  };
  const clock = fakeClock();
  const store = createObjectStore(source, { clock, windowMs: 1000 });
  return {
    store, clock,
    get loads() { return loads; },
    get watching() { return watching; },
    setStatus(s: string) { status = s; },
    emit: (e: string, d: unknown) => emit?.(e, d),
  };
}

describe('object store', () => {
  it('two readers of one ref share one load and one subscription', async () => {
    const h = harness();
    const a = h.store.subscribe(ref, () => {});
    const b = h.store.subscribe(ref, () => {});
    await flush();
    expect(h.loads).toBe(1);
    expect(h.watching).toBe(1);
    expect(h.store.get(ref).view?.status).toBe('pending');
    a(); b();
    expect(h.watching).toBe(0);
  });

  it('a structural event about this task refetches once per window; unrelated tasks are ignored', async () => {
    const h = harness();
    let notified = 0;
    h.store.subscribe(ref, () => { notified += 1; });
    await flush();
    h.setStatus('completed');
    h.emit('worker:completed', { taskId: 'other', workerId: 'w9' });
    h.emit('worker:completed', { taskId: 't1', workerId: 'w1' });
    h.emit('worker:failed', { taskId: 't1', workerId: 'w1' });
    expect(h.loads).toBe(1);
    h.clock.advance(1000);
    await flush();
    expect(h.loads).toBe(2);
    expect(h.store.get(ref).view?.status).toBe('completed');
    expect(notified).toBeGreaterThanOrEqual(2);
  });

  it('a progress tick patches the live overlay without refetching', async () => {
    const h = harness();
    h.store.subscribe(ref, () => {});
    await flush();
    h.emit('worker:progress', { taskId: 't1', workerId: 'w1', status: 'running', currentAction: 'Reading files' });
    h.clock.advance(5000);
    await flush();
    expect(h.loads).toBe(1);
    expect(h.store.live(ref).getSnapshot().t1?.currentAction).toBe('Reading files');
  });

  it('a failed load keeps the last good view and reports the error', async () => {
    let fail = false;
    const store = createObjectStore({ load: async () => { if (fail) throw new Error('404'); return view('pending'); } });
    store.subscribe(ref, () => {});
    await flush();
    fail = true;
    store.refresh(ref);
    await flush();
    expect(store.get(ref).view?.status).toBe('pending');
    expect(store.get(ref).error).toBe('404');
  });
});
