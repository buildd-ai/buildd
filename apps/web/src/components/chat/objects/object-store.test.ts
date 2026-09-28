import { describe, expect, it } from 'bun:test';
import type { Clock } from '@/lib/realtime-throttle';
import type { BuilddObjectRef } from '../chat-contract';
import { MISSION_OBJECT_EXTRA_EVENTS, createObjectStore, watchedTaskIds, type ObjectSource } from './object-store';
import type { MissionObjectView, TaskObjectView } from './object-views';

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

  // The docked pane sat on "waiting for a runner" after a confirm: the planning
  // task is not a Board row, so its claim and worker events were dropped.
  describe('mission: every event for the mission, not just Board rows', () => {
    const mref: BuilddObjectRef = { kind: 'mission', id: 'm1', workspaceId: 'ws', fallbackText: 'mission' };
    const planningView = (live: boolean, workerStatuses: Record<string, string> = {}): MissionObjectView => ({
      kind: 'mission', id: 'm1', workspaceId: 'ws', title: 'm', goal: null, status: 'active', stateLabel: live ? 'Running' : 'Planning',
      workspaceName: null, renderedAt: 0, taskIds: ['plan'], workerStatuses,
      board: { tasks: {}, phases: [], planning: { taskId: 'plan', roleName: 'Organizer', roleColor: null, live, runner: null, startedAt: null, currentAction: null, lastMilestone: null } } as unknown as MissionObjectView['board'],
    });
    function mharness(first: MissionObjectView) {
      let loads = 0;
      let next = first;
      let emit: ((e: string, d: unknown) => void) | null = null;
      const clock = fakeClock();
      const store = createObjectStore({
        load: async () => { loads += 1; return next; },
        watch: (_r, _v, e) => { emit = e; return () => { emit = null; }; },
      }, { clock, windowMs: 1000 });
      return {
        store, clock,
        get loads() { return loads; },
        setNext(v: MissionObjectView) { next = v; },
        emit: (e: string, d: unknown) => emit?.(e, d),
      };
    }

    it('watches the planning task and every mission task, not only Board rows', () => {
      expect(watchedTaskIds(planningView(false)).sort()).toEqual(['plan']);
      const noList = { ...planningView(false), taskIds: undefined };
      expect(watchedTaskIds(noList)).toEqual(['plan']);
    });

    it('the planning task being claimed refetches the pane', async () => {
      const h = mharness(planningView(false));
      h.store.subscribe(mref, () => {});
      await flush();
      h.setNext(planningView(true, { w1: 'idle' }));
      h.emit('task:claimed', { task: { id: 'plan' }, worker: { id: 'w1', status: 'idle' } });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(2);
      expect(h.store.get(mref).view?.kind === 'mission' && h.store.get(mref).view).toMatchObject({ stateLabel: 'Running' });
    });

    it("a worker's first status change after load refetches (baseline comes from the view)", async () => {
      const h = mharness(planningView(true, { w1: 'idle' }));
      h.store.subscribe(mref, () => {});
      await flush();
      h.emit('worker:progress', { taskId: 'plan', workerId: 'w1', status: 'running', currentAction: 'Reading the repo' });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(2);
    });

    it('a claim naming the mission refetches even for a task the view has not seen', async () => {
      const h = mharness(planningView(false));
      h.store.subscribe(mref, () => {});
      await flush();
      h.emit('task:claimed', { task: { id: 'fresh', missionId: 'm1' }, worker: { id: 'w2', status: 'idle' } });
      h.emit('task:claimed', { task: { id: 'elsewhere', missionId: 'm9' }, worker: { id: 'w3', status: 'idle' } });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(2);
    });
  });

  // Visual review (docs/design/visual-qa-human-review.md, Chat): a decision
  // or a new shot changes the mission object's `visual`, so the card, the
  // pinned strip and the pane refetch.
  describe('mission: visual review', () => {
    const mref: BuilddObjectRef = { kind: 'mission', id: 'm1', workspaceId: 'ws', fallbackText: 'mission' };
    const mview = (): MissionObjectView => ({
      kind: 'mission', id: 'm1', workspaceId: 'ws', title: 'm', goal: null, status: 'active', stateLabel: 'Running',
      workspaceName: null, renderedAt: 0, taskIds: ['audit'], workerStatuses: {},
      board: { tasks: {}, phases: [], planning: null } as unknown as MissionObjectView['board'],
    });
    function vharness() {
      let loads = 0;
      let emit: ((e: string, d: unknown) => void) | null = null;
      const clock = fakeClock();
      const store = createObjectStore({
        load: async () => { loads += 1; return mview(); },
        watch: (_r, _v, e) => { emit = e; return () => { emit = null; }; },
      }, { clock, windowMs: 1000 });
      return { store, clock, get loads() { return loads; }, emit: (e: string, d: unknown) => emit?.(e, d) };
    }

    it('the mission channel carries the visual review events', () => {
      expect(MISSION_OBJECT_EXTRA_EVENTS).toContain('mission:visual_review');
      expect(MISSION_OBJECT_EXTRA_EVENTS).toContain('worker:artifact');
    });

    it('mission:visual_review triggers a refetch', async () => {
      const h = vharness();
      h.store.subscribe(mref, () => {});
      await flush();
      h.emit('mission:visual_review', { missionId: 'm1', decision: 'looks_right' });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(2);
    });

    it("another mission's visual review is ignored", async () => {
      const h = vharness();
      h.store.subscribe(mref, () => {});
      await flush();
      h.emit('mission:visual_review', { missionId: 'm9' });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(1);
    });

    it('a new audit shot (worker:artifact naming the mission) triggers a refetch', async () => {
      const h = vharness();
      h.store.subscribe(mref, () => {});
      await flush();
      h.emit('worker:artifact', { artifact: { id: 'a1', workerId: 'w-new', missionId: 'm1' } });
      h.clock.advance(1000);
      await flush();
      expect(h.loads).toBe(2);
    });
  });
});
