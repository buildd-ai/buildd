/**
 * The pure halves of the pieces lifted from buildd's chat in 0.5.0: the
 * object store, the dock models, the parked first message, approval drafts
 * and cost formatting. No DOM.
 */
import { describe, expect, it } from 'bun:test';
import { encodeApprovalPreview, type ChatToolPart, type ObjectRef } from '@builddai/ai-kit/chat/contract';
import { createObjectStore, createTrailingThrottle, type KitClock, type ObjectSource } from './object-store';
import { INITIAL_PANE, dockChoice, paneReducer, parsePaneSide, type PaneState } from './object-dock';
import { createPendingMessages, type PendingStorage } from './pending-message';
import { approvalDraft, approvalLabel, firstParagraph, toolAction } from './approval-draft';
import { formatCost, formatPer1k } from './model';

type Ref = ObjectRef<'order' | 'shipment'>;
const order = (id = 'o1'): Ref => ({ kind: 'order', id, workspaceId: 'w1', fallbackText: `Order ${id}` });

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: KitClock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); }
  };
  return { clock, advance, pending: () => timers.size };
}

const flush = () => new Promise(r => setTimeout(r, 0));

function source(views: Record<string, unknown>) {
  const loads: string[] = [];
  const emits = new Map<string, (event: string, data: unknown) => void>();
  const watched: Array<{ key: string; view: unknown }> = [];
  let unwatched = 0;
  let fail: string | null = null;
  const src: ObjectSource<Ref, { v: number; name: string }> = {
    async load(ref) {
      loads.push(ref.id);
      if (fail) throw new Error(fail);
      return views[ref.id] as { v: number; name: string };
    },
    watch(ref, view, emit) {
      watched.push({ key: ref.id, view });
      emits.set(ref.id, emit);
      return () => { unwatched++; };
    },
  };
  return { src, loads, emits, watched, unwatched: () => unwatched, failWith: (m: string | null) => { fail = m; } };
}

describe('createObjectStore', () => {
  it('loads on first subscribe, shares one entry between readers, and unwatches with the last', async () => {
    const s = source({ o1: { v: 1, name: 'A' } });
    const { clock } = fakeClock();
    const store = createObjectStore(s.src, { clock });
    expect(store.get(order()).loading).toBe(true);
    let a = 0; let b = 0;
    const offA = store.subscribe(order(), () => { a++; });
    const offB = store.subscribe(order(), () => { b++; });
    await flush();
    expect(s.loads).toEqual(['o1']);
    expect(store.get(order())).toEqual({ view: { v: 1, name: 'A' }, error: null, loading: false });
    expect(a).toBe(1);
    expect(b).toBe(1);
    // (The blind watch opened before the load was already swapped once.)
    const base = s.unwatched();
    offA();
    expect(s.unwatched()).toBe(base);
    offB();
    expect(s.unwatched()).toBe(base + 1);
  });

  it('a watch opened before the first load re-opens once the view is known', async () => {
    const s = source({ o1: { v: 1, name: 'A' } });
    const store = createObjectStore(s.src, { clock: fakeClock().clock });
    store.subscribe(order(), () => {});
    expect(s.watched).toEqual([{ key: 'o1', view: null }]);
    await flush();
    expect(s.watched).toEqual([{ key: 'o1', view: null }, { key: 'o1', view: { v: 1, name: 'A' } }]);
    expect(s.unwatched()).toBe(1);
  });

  it('events refetch trailing, at most once per window; classify can ignore or patch', async () => {
    const views = { o1: { v: 1, name: 'A' } };
    const s = source(views);
    const fc = fakeClock();
    const seen: string[] = [];
    const store = createObjectStore(s.src, {
      clock: fc.clock,
      windowMs: 1000,
      sidecar: { create: () => ({ ticks: 0 }) },
      classify(event, _data, ctx) {
        seen.push(event);
        if (event === 'noise') return 'ignore';
        if (event === 'tick') { ctx.sidecar.ticks++; return 'patch'; }
        return 'refresh';
      },
    });
    store.subscribe(order(), () => {});
    await flush();
    expect(s.loads).toEqual(['o1']);
    const emit = s.emits.get('o1')!;
    emit('noise', null);
    emit('tick', null);
    emit('tick', null);
    fc.advance(1000);
    await flush();
    expect(s.loads).toEqual(['o1']);
    expect(store.sidecar(order()).ticks).toBe(2);
    emit('changed', null);
    emit('changed', null);
    emit('changed', null);
    fc.advance(999);
    await flush();
    expect(s.loads).toEqual(['o1']);
    views.o1 = { v: 2, name: 'B' };
    fc.advance(1);
    await flush();
    expect(s.loads).toEqual(['o1', 'o1']);
    expect(store.get(order()).view).toEqual({ v: 2, name: 'B' });
    expect(seen).toEqual(['noise', 'tick', 'tick', 'changed', 'changed', 'changed']);
  });

  it('a failed load keeps the last good view and says why', async () => {
    const s = source({ o1: { v: 1, name: 'A' } });
    const store = createObjectStore(s.src, { clock: fakeClock().clock });
    store.subscribe(order(), () => {});
    await flush();
    s.failWith('Not found');
    store.refresh(order());
    await flush();
    expect(store.get(order())).toEqual({ view: { v: 1, name: 'A' }, error: 'Not found', loading: false });
  });

  it('set replaces a view in place, tells readers, and re-seeds the sidecar', async () => {
    const s = source({ o1: { v: 1, name: 'A' } });
    const reasons: string[] = [];
    const store = createObjectStore(s.src, {
      clock: fakeClock().clock,
      sidecar: { create: () => ({ last: 0 }), onView: (x, view, _ref, reason) => { x.last = view.v; reasons.push(reason); } },
    });
    let n = 0;
    store.subscribe(order(), () => { n++; });
    await flush();
    store.set(order(), { v: 9, name: 'Z' });
    expect(store.get(order()).view).toEqual({ v: 9, name: 'Z' });
    expect(store.sidecar(order()).last).toBe(9);
    expect(reasons).toEqual(['load', 'set']);
    expect(n).toBe(2);
  });

  it('a refresh while one is in flight runs once more after it, not twice at once', async () => {
    const s = source({ o1: { v: 1, name: 'A' } });
    const store = createObjectStore(s.src, { clock: fakeClock().clock });
    store.subscribe(order(), () => {});
    store.refresh(order());
    store.refresh(order());
    await flush();
    await flush();
    expect(s.loads).toEqual(['o1', 'o1']);
  });
});

describe('createTrailingThrottle', () => {
  it('runs once per window, trailing, and cancel drops it', () => {
    const fc = fakeClock();
    let runs = 0;
    const t = createTrailingThrottle(() => { runs++; }, 100, fc.clock);
    t.call(); t.call();
    fc.advance(100);
    expect(runs).toBe(1);
    t.call();
    t.cancel();
    fc.advance(100);
    expect(runs).toBe(1);
  });
});

describe('paneReducer and dockChoice', () => {
  it('open pins and un-closes; close unpins; swap flips the side; unpin keeps it open', () => {
    let s: PaneState<Ref> = INITIAL_PANE;
    expect(s).toEqual({ side: 'left', closed: false, pinned: null });
    s = paneReducer(s, { type: 'close' });
    s = paneReducer(s, { type: 'open', ref: order() });
    expect(s).toEqual({ side: 'left', closed: false, pinned: order() });
    s = paneReducer(s, { type: 'swap' });
    expect(s.side).toBe('right');
    s = paneReducer(s, { type: 'unpin' });
    expect(s).toEqual({ side: 'right', closed: false, pinned: null });
    s = paneReducer(s, { type: 'side', side: 'left' });
    expect(s.side).toBe('left');
    expect(paneReducer(s, { type: 'close' })).toEqual({ side: 'left', closed: true, pinned: null });
  });
  it('parsePaneSide: anything but right is left', () => {
    expect(parsePaneSide('right')).toBe('right');
    for (const v of ['left', '', null, undefined, 'RIGHT']) expect(parsePaneSide(v)).toBe('left');
  });
  it('history, then focus, then what needs you unless it was closed', () => {
    const needs = order('n1');
    expect(dockChoice({ historyOpen: true, focus: order(), needsRef: needs, needsClosedId: null })).toEqual({ mode: 'history', ref: null });
    expect(dockChoice({ historyOpen: false, focus: order(), needsRef: needs, needsClosedId: null })).toEqual({ mode: 'object', ref: order() });
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: needs, needsClosedId: null })).toEqual({ mode: 'needs', ref: needs });
    expect(dockChoice({ historyOpen: false, focus: null, needsRef: needs, needsClosedId: 'n1' })).toBeNull();
    expect(dockChoice<Ref>({ historyOpen: false, focus: null, needsRef: null, needsClosedId: null })).toBeNull();
  });
});

describe('createPendingMessages', () => {
  const mem = (): PendingStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  };
  it('parks under the prefix and takes it once', () => {
    const s = mem();
    const p = createPendingMessages({ prefix: 'app:', storage: () => s });
    p.park('c1', 'hello');
    expect(s.data.get('app:c1')).toBe('hello');
    expect(p.key('c1')).toBe('app:c1');
    expect(p.take('c1')).toBe('hello');
    expect(p.take('c1')).toBeNull();
  });
  it('no storage, or a storage that throws, degrades to nothing parked', () => {
    expect(createPendingMessages({ storage: () => null }).take('c1')).toBeNull();
    const boom: PendingStorage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    const p = createPendingMessages({ storage: () => boom });
    expect(() => p.park('c1', 'x')).not.toThrow();
    expect(p.take('c1')).toBeNull();
  });
  it('defaults to the kit prefix', () => {
    expect(createPendingMessages({ storage: () => null }).key('c1')).toBe('kit-chat-pending:c1');
  });
});

describe('approvalDraft and approvalLabel', () => {
  const part = (input: Record<string, unknown>, name = 'manage_orders', requestReason?: string): ChatToolPart => ({
    type: `tool-${name}`, toolCallId: 'c1', state: 'approval-requested', input, approval: { id: 'ap-1', ...(requestReason ? { requestReason } : {}) },
  } as ChatToolPart);

  it('a server preview wins: headline, change lines, note, confirm text, its workspace', () => {
    const reason = encodeApprovalPreview({
      v: 1, verb: 'Hold shipment', target: { kind: 'shipment', id: 's1', label: 'north', detail: 'in transit', workspaceId: 'w2' },
      changes: [{ label: 'Status', before: 'in transit', after: 'held' }], note: 'The carrier is told.', confirmText: 'north', fingerprint: 'f',
    });
    const d = approvalDraft(part({ action: 'hold', workspaceId: 'w1' }, 'hold_shipment', reason));
    expect(d.kind).toBe('preview');
    if (d.kind !== 'preview') return;
    expect(d.headline).toContain('Hold shipment');
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].line).toContain('held');
    expect(d.note).toBe('The carrier is told.');
    expect(d.confirmText).toBe('north');
    expect(d.workspaceId).toBe('w2');
  });

  it('no preview: the input fields, minus action and workspace, and nothing empty', () => {
    const d = approvalDraft(part({ action: 'create', workspaceId: 'w1', title: 'Restock', qty: 3, note: null, empty: '' }));
    expect(d).toEqual({ kind: 'generic', fields: [{ key: 'title', value: 'Restock' }, { key: 'qty', value: '3' }], workspaceId: 'w1' });
  });

  it('custom is asked first and may fall through', () => {
    const custom = (p: ChatToolPart) => (toolAction(p) === 'create' ? { kind: 'order' as const, title: 'x' } : null);
    expect(approvalDraft(part({ action: 'create' }), { custom }).kind).toBe('order');
    expect(approvalDraft(part({ action: 'update' }), { custom }).kind).toBe('generic');
  });

  it('labels: tool:action wins over tool; unlisted tools read humanised', () => {
    const labels = { 'manage_orders:create': 'New order', manage_orders: 'Change order' };
    expect(approvalLabel(part({ action: 'create' }), labels)).toBe('New order');
    expect(approvalLabel(part({ action: 'delete' }), labels)).toBe('Change order');
    expect(approvalLabel(part({}, 'hold_shipment'), labels)).toBe('Hold shipment');
  });

  it('firstParagraph strips markdown and keeps the first block', () => {
    expect(firstParagraph('# Title *here*\nmore\n\nsecond')).toBe('Title here more');
    expect(firstParagraph(null)).toBeNull();
    expect(firstParagraph('  \n\n x')).toBeNull();
  });
});

describe('formatCost and formatPer1k', () => {
  it('cost: empty for nothing, a floor under a cent, two decimals otherwise', () => {
    for (const v of [null, undefined, 0, -1, Number.NaN]) expect(formatCost(v)).toBe('');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
  it('per-1k: two significant figures, no trailing zeros', () => {
    expect(formatPer1k(0.003)).toBe('$0.003');
    expect(formatPer1k(0.01234)).toBe('$0.012');
    expect(formatPer1k(0)).toBe('$0');
  });
});
