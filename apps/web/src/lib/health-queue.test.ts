/**
 * Acceptance tests for Living Spec "Health › Queue: what is waiting, why, and
 * whether it should be" (4bc3e70e, revision 6). Written before the build: they
 * pin the interface the build must provide in `lib/health-queue.ts` and fail
 * until it exists.
 *
 * Contract the build provides (pure, no I/O):
 *   buildQueueView(input, now) -> QueueView
 *   loadQueue({ read, page, filter }) -> QueueView           (one bounded read)
 *   queueReason(task) -> { kind, badge, blockedBy }          (shared by Queue, task page, explain, terminal Queue)
 * Input task: { id, title, state: running|ready|waiting|parked, workspaceId, missionId,
 *   ageMs, wait?: { kind: declared|lane|limit, ... }, ... }.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEALTH_NAV } from './nav-config';
import { buildQueueView, loadQueue, queueReason, type QueueInput } from './health-queue';

const NOW = new Date('2026-10-22T12:00:00Z');
const HOUR = 3_600_000;

function task(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Task ${id}`, state, workspaceId: 'w1', missionId: null, ageMs: HOUR, ...extra } as any;
}
function input(over: Partial<QueueInput> = {}): QueueInput {
  return { slots: { used: 0, total: 6 }, tasks: [], lanes: [], idleSlots: 0, startable: [], ...over } as QueueInput;
}
const view = (over: Partial<QueueInput> = {}) => buildQueueView(input(over), NOW);

describe('R-1: Queue is a Health tab between Runners and Usage', () => {
  it('sits between Runners and Usage and is open to every member', () => {
    const ids = HEALTH_NAV.map(i => i.id);
    const q = HEALTH_NAV.find(i => i.id === 'queue');
    expect(q).toBeDefined();
    expect(q!.href).toBe('/app/health/queue');
    expect(q!.operatorOnly).toBeFalsy();
    expect(q!.teamAdminOnly).toBeFalsy();
    expect(ids.indexOf('queue')).toBe(ids.indexOf('runners') + 1);
    expect(ids.indexOf('queue')).toBeLessThan(ids.indexOf('usage'));
  });
  it('carries the waiting count beside its label', () => {
    expect(view({ tasks: [task('a', 'waiting', { wait: { kind: 'limit' } })] }).navCount).toBe(1);
  });
});

describe('R-2: filters apply to every number, slots stay team-wide', () => {
  it('narrows counts by workspace and mission but not slots', () => {
    const tasks = [
      task('a', 'waiting', { workspaceId: 'w1', wait: { kind: 'limit' } }),
      task('b', 'waiting', { workspaceId: 'w2', wait: { kind: 'limit' } }),
      task('c', 'ready', { workspaceId: 'w2', missionId: 'm1' }),
    ];
    const v = buildQueueView(input({ tasks, slots: { used: 3, total: 6 }, filter: { workspaceId: 'w2' } } as any), NOW);
    expect(v.tiles.waiting.count).toBe(1);
    expect(v.tiles.ready.count).toBe(1);
    expect(v.tiles.running.slots).toBe(6);
    expect(v.tiles.running.used).toBe(3);
    const m = buildQueueView(input({ tasks, filter: { missionId: 'm1' } } as any), NOW);
    expect(m.tiles.waiting.count).toBe(0);
  });
});

describe('R-3: four tiles', () => {
  it('has Running n/m, Ready, Waiting (with a reason bar), Parked, each linking to its rows', () => {
    const v = view({ tasks: [task('a', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 2 } }), task('b', 'waiting', { wait: { kind: 'limit' } })] });
    expect(Object.keys(v.tiles)).toEqual(['running', 'ready', 'waiting', 'parked']);
    expect(v.tiles.waiting.byReason).toEqual({ declared: 0, lane: 1, limit: 1 });
    for (const t of Object.values(v.tiles) as any[]) expect(t.href).toMatch(/^\/app\/health\/queue/);
  });
});

describe('R-4: one alert line, only when something is wrong, worst first', () => {
  it('is null on desktop and reads "Nothing held that could run" on phone when healthy', () => {
    const v = view();
    expect(v.alert).toBeNull();
    expect(v.phoneAlertFallback).toBe('Nothing held that could run');
  });
  it('lists idle slots before stuck lanes', () => {
    const v = view({
      idleSlots: 2, startable: [{ id: 'r', cause: 'no reviewer runner online' }],
      lanes: [{ name: 'Schema', holder: { id: 'h', state: 'pr_open', lastPrActivityMs: 30 * HOUR }, waiting: [] }],
    } as any);
    expect(v.alert!.lines[0]).toContain('2 idle slots, 1 tasks could start');
    expect(v.alert!.lines[1]).toContain('Schema lane stuck');
  });
});

describe('R-5: exactly one reason badge per waiting task', () => {
  it('maps Declared / Lane / Limit with Blocked by, and ready tasks get none', () => {
    expect(queueReason(task('b', 'waiting', { wait: { kind: 'declared', blockerId: 'a', blockerStatus: 'running' } })).badge).toBe('Declared');
    const lane = queueReason(task('c', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 3 } }));
    expect(lane.badge).toBe('Lane');
    expect(lane.blockedBy).toBe('Schema lane · 3rd');
    const lim = queueReason(task('d', 'waiting', { wait: { kind: 'limit', limit: 'daily budget', liftsAt: '2026-10-23T00:00:00Z' } }));
    expect(lim.badge).toBe('Limit');
    expect(lim.blockedBy).toContain('daily budget');
    expect(queueReason(task('e', 'ready'))).toEqual({ kind: null, badge: null, blockedBy: null });
  });
  it('never labels a gated task ready or next', () => {
    const v = view({ tasks: [task('a', 'waiting', { wait: { kind: 'limit' } })] });
    expect(JSON.stringify(v.ready)).not.toContain('"a"');
  });
  it('has no "Guessed" badge (removed in r5)', () => {
    expect(JSON.stringify(view())).not.toContain('Guessed');
  });
});

describe('R-6: Waiting table', () => {
  it('has Task / Reason / Blocked by / Age columns and All / Declared / Lane / Limit segments', () => {
    const v = view();
    expect(v.waitingTable.columns).toEqual(['Task', 'Reason', 'Blocked by', 'Age']);
    expect(v.waitingTable.segments).toEqual(['All', 'Declared', 'Lane', 'Limit']);
  });
  it('sorts Lane, Limit, Declared, then lane position / age', () => {
    const v = view({ tasks: [
      task('d', 'waiting', { wait: { kind: 'declared', blockerId: 'x' } }),
      task('l2', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 2 } }),
      task('m', 'waiting', { wait: { kind: 'limit' }, ageMs: 5 * HOUR }),
      task('l1', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 1 } }),
    ] });
    expect(v.waitingTable.rows.map((r: any) => r.id)).toEqual(['l1', 'l2', 'm', 'd']);
  });
});

describe('R-7: Ready in claim order, Parked one line', () => {
  it('shows Starts now / next free slot / why no runner takes it', () => {
    const v = view({ tasks: [
      task('a', 'ready', { startsNow: true }),
      task('b', 'ready', { nextSlotAt: '2026-10-22T12:30:00Z' }),
      task('c', 'ready', { noRunnerReason: 'no reviewer runner online' }),
      task('p', 'parked', { startAt: '2026-10-23T09:00:00Z' }),
    ] });
    expect(v.ready.map((r: any) => r.when)).toEqual(['Starts now', expect.stringContaining('next free slot ~'), 'no reviewer runner online']);
    expect(v.parked).toHaveLength(1);
    expect(v.parked[0].startAt).toBe('2026-10-23T09:00:00Z');
  });
});

describe('R-8: Lanes card', () => {
  it('lists name, holder state and waiting count, hidden when no lane is in use', () => {
    const lanes = [{ name: 'Schema', holder: { id: 'h', state: 'ci', lastPrActivityMs: HOUR }, waiting: [{ id: 'w' }] }];
    const v = view({ lanes } as any);
    expect(v.lanes).toEqual([expect.objectContaining({ name: 'Schema', holderState: 'ci', waitingCount: 1 })]);
    expect(view().lanes).toBeNull();
  });
});

describe('R-9: lane panel', () => {
  it('shows the holder first then positions; Release only when stuck', () => {
    const lanes = [{ name: 'Schema', holder: { id: 'h', state: 'pr_open', lastPrActivityMs: 30 * HOUR, ageMs: 40 * HOUR }, waiting: [{ id: 'w1' }, { id: 'w2' }] }];
    const p = view({ lanes } as any).lanePanels.Schema;
    expect(p.entries.map((e: any) => e.id)).toEqual(['h', 'w1', 'w2']);
    expect(p.entries.map((e: any) => e.position ?? null)).toEqual([null, 1, 2]);
    expect(p.stuck.duration).toBeTruthy();
    expect(p.actions).toContain('Release');
  });
});

describe('R-10: Force start only on Limit rows', () => {
  it('offers it for Limit and never for Lane or Declared', () => {
    const v = view({ tasks: [
      task('lim', 'waiting', { wait: { kind: 'limit' } }),
      task('lane', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 1 } }),
      task('dec', 'waiting', { wait: { kind: 'declared', blockerId: 'x' } }),
    ] });
    const by = Object.fromEntries(v.waitingTable.rows.map((r: any) => [r.id, r]));
    expect(by.lim.actions).toContain('Force start');
    expect(by.lane.actions).not.toContain('Force start');
    expect(by.dec.actions).not.toContain('Force start');
    expect(by.lim.forceStartSheet.rows.map((r: any) => r.label)).toEqual(['Skips', 'Still enforced']);
  });
});

describe('R-11: Declared row sheet', () => {
  it('opens Depends on / Status / Set by / Why with the blocker next step primary and a reasoned Remove', () => {
    const v = view({ tasks: [task('b', 'waiting', { wait: { kind: 'declared', blockerId: 'a', blockerStatus: 'pr_open', setBy: 'max', why: 'needs schema', blockerNextStep: 'Review PR' } })] });
    const s = v.waitingTable.rows[0].declaredSheet;
    expect(s.rows.map((r: any) => r.label)).toEqual(['Depends on', 'Status', 'Set by', 'Why']);
    expect(s.primary).toBe('Review PR');
    expect(s.remove.requiresReason).toBe(true);
  });
});

describe('R-12: every action also exists on the task page', () => {
  it('the task page offers the same actions through the shared module', () => {
    const src = readFileSync(join(__dirname, '../app/app/(protected)/tasks/[id]/page.tsx'), 'utf8');
    expect(src).toContain('health-queue');
  });
});

describe('R-13: labels over sentences, no internal names', () => {
  it('uses no internal vocabulary in the rendered view', () => {
    const v = view({ tasks: [task('a', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 1 } })], lanes: [] });
    const text = JSON.stringify(v);
    for (const bad of ['coordination_gate', 'hardSurface', 'pathClaim', 'orchestration_decisions', 'undefined', 'NaN']) expect(text).not.toContain(bad);
  });
});

describe('R-14: one bounded read, 50 rows a page', () => {
  it('reads once with a limit of at most 50 and pages', async () => {
    let calls = 0; let seen: any;
    const rows = Array.from({ length: 50 }, (_, i) => task(`t${i}`, 'waiting', { wait: { kind: 'limit' } }));
    const v = await loadQueue({ page: 1, read: async (q: any) => { calls++; seen = q; return { counts: { running: 0, ready: 0, waiting: 400, parked: 0, byReason: { declared: 0, lane: 0, limit: 400 } }, rows, slots: { used: 0, total: 6 } }; } } as any);
    expect(calls).toBe(1);
    expect(seen.limit).toBeLessThanOrEqual(51);
    expect(v.waitingTable.rows).toHaveLength(50);
    expect(v.waitingTable.hasMore).toBe(true);
  });
});

describe('R-15: ships after Overlap scheduling lane order and claim-order presentation', () => {
  it('lane order is read from the stored lane order the overlap spec introduces', () => {
    const src = readFileSync(join(__dirname, 'health-queue.ts'), 'utf8');
    expect(src).toMatch(/claim-order|laneOrder|lane-order/);
  });
});

describe('AC-1: tiles read 4/6, 2, 9, 1 and link to rows', () => {
  it('counts', () => {
    const tasks = [
      ...Array.from({ length: 4 }, (_, i) => task(`r${i}`, 'running')),
      ...Array.from({ length: 2 }, (_, i) => task(`y${i}`, 'ready')),
      ...Array.from({ length: 9 }, (_, i) => task(`w${i}`, 'waiting', { wait: { kind: 'limit' } })),
      task('p', 'parked'),
    ];
    const v = view({ tasks, slots: { used: 4, total: 6 } });
    expect([v.tiles.running.label, v.tiles.ready.count, v.tiles.waiting.count, v.tiles.parked.count]).toEqual(['4/6', 2, 9, 1]);
    for (const t of Object.values(v.tiles) as any[]) expect(t.href).toBeTruthy();
  });
});

describe('AC-2: idle slots with an unserved ready task alert with the cause', () => {
  it('names idle slots and cause', () => {
    const v = view({ idleSlots: 2, startable: [{ id: 'r', cause: 'no reviewer runner online' }], tasks: [task('r', 'ready')] } as any);
    expect(v.alert!.lines[0]).toMatch(/2 idle slots/);
    expect(v.alert!.lines[0]).toContain('no reviewer runner online');
  });
});

describe('AC-3: Declared names A, Lane reads "Schema · 3rd"', () => {
  it('badges', () => {
    const v = view({ tasks: [
      task('B', 'waiting', { wait: { kind: 'declared', blockerId: 'A', blockerTitle: 'Task A' } }),
      task('C', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 3 } }),
    ] });
    const by = Object.fromEntries(v.waitingTable.rows.map((r: any) => [r.id, r]));
    expect(by.B.reason).toBe('Declared');
    expect(by.B.blockedBy).toContain('Task A');
    expect(by.C.reason).toBe('Lane');
    expect(by.C.blockedBy).toBe('Schema · 3rd');
  });
});

describe('AC-4: stuck lane holder alerts and offers Release', () => {
  it('after 24 hours without PR activity', () => {
    const lanes = [{ name: 'Schema', holder: { id: 'h', state: 'pr_open', lastPrActivityMs: 24 * HOUR }, waiting: [] }];
    const v = view({ lanes } as any);
    expect(v.alert!.lines.join(' ')).toContain('Schema lane stuck');
    expect(v.lanePanels.Schema.actions).toContain('Release');
    const fresh = view({ lanes: [{ ...lanes[0], holder: { ...lanes[0].holder, lastPrActivityMs: 23 * HOUR } }] } as any);
    expect(fresh.lanePanels.Schema.actions).not.toContain('Release');
  });
});

describe('AC-5: no lane in use, no Lanes card', () => {
  it('hides the card', () => expect(view().lanes).toBeNull());
});

describe('AC-6: lane panel order matches the claim route', () => {
  it('holder first, waiters in position order', () => {
    const lanes = [{ name: 'Migration', holder: { id: 'h', state: 'running', lastPrActivityMs: 0 }, waiting: [{ id: 'b', position: 2 }, { id: 'a', position: 1 }] }];
    const p = view({ lanes } as any).lanePanels.Migration;
    expect(p.entries.map((e: any) => e.id)).toEqual(['h', 'a', 'b']);
    expect(p.entries[0].state).toBe('running');
  });
});

describe('AC-7: Force start sheet and call', () => {
  it('Limit row lists Skips and Still enforced and confirms to /start with the digest', () => {
    const v = view({ tasks: [task('lim', 'waiting', { wait: { kind: 'limit', digest: 'abc123' } })] });
    const row = v.waitingTable.rows[0];
    expect(row.forceStartSheet.rows.map((r: any) => r.label)).toEqual(['Skips', 'Still enforced']);
    expect(row.forceStartSheet.confirm).toEqual({ method: 'POST', url: '/api/tasks/lim/start', body: { digest: 'abc123' } });
  });
  it('Lane and Declared rows offer none', () => {
    const v = view({ tasks: [task('l', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 1 } }), task('d', 'waiting', { wait: { kind: 'declared', blockerId: 'x' } })] });
    for (const r of v.waitingTable.rows) expect(r.forceStartSheet ?? null).toBeNull();
  });
});

describe('AC-8: Declared row sheet', () => {
  it('blocker next step is primary, Remove requires a reason', () => {
    const v = view({ tasks: [task('b', 'waiting', { wait: { kind: 'declared', blockerId: 'a', blockerNextStep: 'Merge PR' } })] });
    const s = v.waitingTable.rows[0].declaredSheet;
    expect(s.primary).toBe('Merge PR');
    expect(s.remove.requiresReason).toBe(true);
  });
});

describe('AC-9: one pending task gives one reason everywhere', () => {
  it('Queue row, task page, explain and the terminal Queue all read queueReason', () => {
    const t = task('x', 'waiting', { wait: { kind: 'lane', lane: 'schema', position: 2 } });
    expect(view({ tasks: [t] }).waitingTable.rows[0].blockedBy).toBe(queueReason(t).blockedBy);
    const base = join(__dirname, '..');
    for (const f of ['app/api/explain/route.ts', 'lib/claim-order-queue.ts', 'app/app/(protected)/tasks/[id]/page.tsx']) {
      expect(readFileSync(join(base, f), 'utf8')).toContain('health-queue');
    }
  });
});

describe('AC-10: 400 pending tasks, one bounded read, 50 rows, exact tiles', () => {
  it('pages and counts exactly', async () => {
    let calls = 0;
    const rows = Array.from({ length: 50 }, (_, i) => task(`t${i}`, 'waiting', { wait: { kind: 'limit' } }));
    const v = await loadQueue({ page: 1, read: async () => { calls++; return { counts: { running: 0, ready: 0, waiting: 400, parked: 0, byReason: { declared: 0, lane: 0, limit: 400 } }, rows, slots: { used: 0, total: 6 } }; } } as any);
    expect(calls).toBe(1);
    expect(v.tiles.waiting.count).toBe(400);
    expect(v.waitingTable.rows).toHaveLength(50);
    expect(v.waitingTable.hasMore).toBe(true);
  });
});
