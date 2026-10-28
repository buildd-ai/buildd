/**
 * Acceptance tests for Living Spec "Health › Queue: what is waiting, why, and
 * whether it should be" (4bc3e70e, revision 6), one test per R-n and AC-n,
 * written against the shipped API:
 *   loadHealthQueue(input, deps)        lib/health-queue.ts       (one bounded read)
 *   buildHealthQueueView(input)         lib/health-queue-view.ts  (pure: tiles, alert, lanes, tables)
 *   QueueBoard / QueueSheets bodies     app/app/(protected)/health/queue/
 *   queueWaitBadge / queueWaitBlockedBy @buildd/shared            (the one reason vocabulary)
 * Test names carry their criterion id: scripts/run-acceptance-tests.ts selects by it.
 */
import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { queueWaitBadge, queueWaitBlockedBy, type HealthQueueLane, type HealthQueueWaitingRow, type QueueWait } from '@buildd/shared';
import { HEALTH_NAV } from '../../src/lib/nav-config';
import { HEALTH_QUEUE_LIMIT, loadHealthQueue, type HealthQueueDeps } from '../../src/lib/health-queue';
import { buildHealthQueueView, type HealthQueueLaneMemberInput, type HealthQueueTaskInput, type HealthQueueViewInput } from '../../src/lib/health-queue-view';
import type { RunnerQueueRow } from '../../src/lib/claim-order-queue';
import QueueBoard from '../../src/app/app/(protected)/health/queue/QueueBoard';
import { DependencyBody, LaneBody } from '../../src/app/app/(protected)/health/queue/QueueSheets';
import { rowAction } from '../../src/app/app/(protected)/health/queue/queue-board-model';
import { startStatusLine } from '../../src/app/app/(protected)/health/queue/QueueStartSheet';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOUR = 3_600_000;
const noop = () => {};
const src = (rel: string) => readFileSync(join(__dirname, '../../src', rel), 'utf8');

let n = 0;
function task(wait: QueueWait | null, over: Partial<HealthQueueTaskInput> = {}): HealthQueueTaskInput {
  n += 1;
  return { id: `t-${n}`, title: `Task ${n}`, workspaceId: 'w1', missionTitle: null, createdAt: new Date(NOW - n * HOUR).toISOString(), wait, ...over };
}
function input(over: Partial<HealthQueueViewInput> = {}): HealthQueueViewInput {
  return { now: NOW, running: 0, slots: 0, teamBusy: 0, tasks: [], lanes: [], filter: 'all', page: 1, truncated: false, missions: [], ...over };
}
const view = (over: Partial<HealthQueueViewInput> = {}) => buildHealthQueueView(input(over));
const html = (over: Partial<HealthQueueViewInput> = {}) =>
  renderToStaticMarkup(h(QueueBoard, { view: view(over), onFilter: noop, onPage: noop, onOpenLane: noop, onOpenRow: noop, onStart: noop }));

const slot: QueueWait = { kind: 'slot' };
const limit: QueueWait = { kind: 'limit', limit: 'mission_cap', liftsAt: new Date(NOW + 4 * 60_000).toISOString(), forceable: true };
const declared = (over: Partial<QueueWait> = {}): QueueWait => ({ kind: 'declared', blockerId: 'a', blockerTitle: 'Task A', blockerStatus: 'in_progress', count: 1, ...over });
const laneWait = (position: number): QueueWait => ({ kind: 'lane', lane: 'migration', position, holderTaskId: 'h' });
const parkedWait: QueueWait = { kind: 'start_time', startAt: new Date(NOW + 2 * HOUR).toISOString() };

const holder = (over: Partial<HealthQueueLaneMemberInput> = {}): HealthQueueLaneMemberInput =>
  ({ taskId: 'h', title: 'Add column', holding: true, status: 'in_progress', prNumber: null, since: new Date(NOW - 2 * HOUR).toISOString(), stuckSince: null, ...over });
const waiter = (taskId: string, title: string): HealthQueueLaneMemberInput =>
  ({ taskId, title, holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null });
const lane = (members: HealthQueueLaneMemberInput[]) => ({ workspaceId: 'w1', lane: 'migration', members });

function waitingRow(wait: QueueWait, over: Partial<HealthQueueWaitingRow> = {}): HealthQueueWaitingRow {
  return {
    id: 't-x', title: 'Ship it', workspaceId: 'w1', missionTitle: null, reason: wait.kind as HealthQueueWaitingRow['reason'],
    badge: queueWaitBadge(wait) ?? '', blockedBy: queueWaitBlockedBy(wait, NOW) ?? '', blockerId: null, blockerStatus: null,
    setBy: null, why: null, lane: null, age: '1h', forceable: wait.forceable === true, wait, ...over,
  };
}

// The loader's one read, with every dependency stubbed.
function row(i: number, over: Partial<RunnerQueueRow> = {}): RunnerQueueRow {
  return {
    id: `r-${i}`, title: `Row ${i}`, workspaceId: 'w1', workspaceName: 'Repo', teamId: 'team-1', teamName: 'Team',
    missionId: null, missionTitle: null, roleSlug: null, backend: null, priority: 0,
    createdAt: new Date(NOW - i * 60_000), startAt: null, dependsOn: [], workspacePausedUntil: null, ...over,
  } as RunnerQueueRow;
}
function deps(over: Partial<HealthQueueDeps> = {}): HealthQueueDeps {
  return {
    rows: mock(async () => [] as RunnerQueueRow[]),
    waits: mock(async (ids: string[]) => new Map(ids.map(id => [id, limit]))),
    lanes: mock(async () => ({ lanes: new Map(), releasedTaskIds: new Set<string>() })),
    titles: mock(async () => new Map<string, string>()),
    live: mock(async (ws: string[]) => (ws.length > 1 ? 5 : 2)),
    slots: mock(async () => 6),
    ...over,
  };
}
const scope = { teamId: 'team-1', teamWorkspaceIds: ['w1', 'w2'], workspaceIds: ['w1'], filter: 'all' as const, page: 1, now: new Date(NOW) };

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
});

describe('R-2: filters apply to every number, slots stay team-wide', () => {
  it('narrows rows and running by mission while slots and idle capacity read the whole team', async () => {
    const d = deps({ rows: mock(async () => [row(1, { missionId: 'm-a', missionTitle: 'Alpha' }), row(2, { missionId: 'm-b', missionTitle: 'Beta' })]) });
    const v = await loadHealthQueue({ ...scope, missionId: 'm-a' }, d);
    expect((d.waits as any).mock.calls[0][0]).toEqual(['r-1']);
    expect(v.tiles.waiting).toBe(1);
    expect(v.tiles.running).toBe(2); // the filtered scope
    expect(v.tiles.slots).toBe(6); // the team's
    expect((d.slots as any).mock.calls[0].slice(0, 2)).toEqual(['team-1', ['w1', 'w2']]);
    expect((d.live as any).mock.calls.some((c: any[]) => c[0].length > 1 && c[1] === null)).toBe(true); // team-wide busy
    expect(v.missions).toEqual([{ id: 'm-a', title: 'Alpha' }, { id: 'm-b', title: 'Beta' }]); // options stay whole
  });
});

describe('R-3: four tiles', () => {
  it('has Running n/m, Ready, Waiting (with a reason bar), Parked, each linking to its rows', () => {
    const over = { running: 1, slots: 6, tasks: [task(slot), task(laneWait(1)), task(limit), task(parkedWait)] };
    expect(view(over).tiles).toMatchObject({ running: 1, slots: 6, ready: 1, waiting: 2, parked: 1, waitingByReason: { declared: 0, lane: 1, limit: 1 } });
    const out = html(over);
    expect(out).toContain('1/6');
    for (const id of ['queue-tile-running', 'queue-tile-queued', 'queue-tile-blocked', 'queue-tile-scheduled']) expect(out).toContain(`data-testid="${id}"`);
    expect(out).toContain('queue-blocked-bar');
    expect(out).toContain('href="#queue-ready"');
    expect(out).toContain('href="#queue-waiting"');
    expect(out).toContain('href="#queue-parked"');
    expect(out).toContain('href="/app/health/runners"');
  });
});

describe('R-4: one alert line, only when something is wrong, worst first', () => {
  it('is absent on every viewport when healthy', () => {
    expect(view().alert).toBeNull();
    const calm = html();
    expect(calm).not.toContain('queue-alert');
    // The phone shows one calm line instead (r8); it is hidden from md up.
    expect(calm).toMatch(/data-testid="queue-calm"[^>]*md:hidden/);
  });
  it('lists idle slots before stuck lanes, on one line', () => {
    const stuck = holder({ status: 'completed', prNumber: 1, stuckSince: new Date(NOW - 30 * HOUR).toISOString() });
    const v = view({ slots: 2, teamBusy: 0, tasks: [task(slot)], lanes: [lane([stuck])] });
    expect(v.alert).toBe('2 idle slots, 1 task could start · Schema lane stuck 30h');
    expect(html({ slots: 2, tasks: [task(slot)] })).toContain('data-testid="queue-alert"');
  });
});

describe('R-5: exactly one reason badge per waiting task', () => {
  it('maps Declared / Lane / Limit with Blocked by, and ready tasks get none', () => {
    expect(queueWaitBadge(declared())).toBe('Declared');
    expect(queueWaitBlockedBy(declared(), NOW)).toBe('Task A');
    expect(queueWaitBadge(laneWait(3))).toBe('Lane');
    expect(queueWaitBlockedBy(laneWait(3), NOW)).toBe('Schema lane · 3rd');
    expect(queueWaitBadge(limit)).toBe('Limit');
    expect(queueWaitBlockedBy(limit, NOW)).toContain('Mission limit');
    expect(queueWaitBadge(slot)).toBeNull();
  });
  it('never lists a gated task as ready, and has no Guessed badge', () => {
    const gated = task(limit);
    const v = view({ tasks: [gated, task(slot)] });
    expect(v.ready.map(r => r.id)).not.toContain(gated.id);
    expect(JSON.stringify(v)).not.toContain('Guessed');
    expect(view({ tasks: [task(null)], reasonsUnavailable: true }).tiles.ready).toBe(0);
  });
});

describe('R-6: Waiting table', () => {
  it('has Task / Reason / Blocked by / Age columns and All / Declared / Lane / Limit segments', () => {
    const out = html({ tasks: [task(limit)] });
    for (const col of ['Task', 'Reason', 'Waiting on']) expect(out).toContain(`<span>${col}</span>`);
    expect(out).toMatch(/<span[^>]*>Age<\/span>/);
    expect(out).toMatch(/>All<span[^>]*>1<.*>Lane<span[^>]*>0<.*>Limit<span[^>]*>1<.*>Dependency<span[^>]*>0</s);
  });
  it('sorts Lane, Limit, Declared, then lane position / age', () => {
    const d = task(declared());
    const l1 = task(limit, { createdAt: new Date(NOW - HOUR).toISOString() });
    const l2 = task(limit, { createdAt: new Date(NOW - 9 * HOUR).toISOString() });
    const s2 = task(laneWait(2));
    const s1 = task(laneWait(1));
    expect(view({ tasks: [d, l1, l2, s2, s1] }).waiting.rows.map(r => r.id)).toEqual([s1.id, s2.id, l2.id, l1.id, d.id]);
  });
});

describe('R-7: Ready in claim order, Parked one line', () => {
  it('shows Starts now / next free slot / why no runner takes it', () => {
    const v = view({ slots: 1, teamBusy: 0, tasks: [
      task(slot), task(slot), task({ kind: 'slot', noRunnerReason: 'no reviewer runner online' }), task(parkedWait),
    ] });
    expect(v.ready.map(r => r.note)).toEqual(['Starts now', 'Next free slot', 'No runner: no reviewer runner online']);
    expect(v.parked).toHaveLength(1);
    expect(v.parked[0].starts).toBe('Starts in 2h 00m');
  });
});

describe('R-8: Lanes card', () => {
  it('lists name, holder state and waiting count, hidden when no lane is in use', () => {
    const out = html({ lanes: [lane([holder(), waiter('w', 'Rename table')])] });
    expect(out).toContain('queue-lanes');
    expect(out).toContain('schema');
    expect(out).toContain('Add column');
    expect(out).toContain('Running');
    expect(out).toMatch(/data-testid="queue-lane-waiting"[^>]*>\+1</);
    expect(html()).not.toContain('queue-lanes');
  });
});

const panelLane: HealthQueueLane = {
  workspaceId: 'w1', lane: 'migration', name: 'Schema', stuckFor: '26h',
  holder: { taskId: 'h', title: 'Add column', position: null, state: 'PR open', age: '30h', prNumber: 9 },
  waiters: [
    { taskId: 'w1', title: 'First', position: 1, state: null, age: '5h', prNumber: null },
    { taskId: 'w2', title: 'Second', position: 2, state: null, age: '1h', prNumber: null },
  ],
};
const laneBody = (l: HealthQueueLane) => renderToStaticMarkup(h(LaneBody, { lane: l, confirming: false, busy: false, error: null, onRelease: noop, onConfirm: noop, onCancel: noop }));

describe('R-9: lane panel', () => {
  it('shows the holder first then positions; Release only when stuck', () => {
    const out = laneBody(panelLane);
    expect(out.indexOf('Add column')).toBeGreaterThan(-1);
    expect(out.indexOf('Add column')).toBeLessThan(out.indexOf('First'));
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
    expect(out).toContain('1st');
    expect(out).toContain('2nd');
    expect(out).toContain('queue-lane-release');
    expect(laneBody({ ...panelLane, stuckFor: null })).not.toContain('queue-lane-release');
  });
});

describe('R-10: Force start only on Limit rows', () => {
  it('offers it for a forceable Limit and never for Lane or Declared', () => {
    const v = view({ tasks: [task(limit), task(laneWait(1)), task(declared())] });
    expect(Object.fromEntries(v.waiting.rows.map(r => [r.reason, r.forceable]))).toEqual({ lane: false, limit: true, declared: false });
    // A Declared row is offered Start anyway (r8 R-20), never Force start; the board renders each row in a phone and a desktop layout.
    const out = html({ tasks: [task(limit), task(laneWait(1)), task(declared())] });
    expect(out).toContain('data-action="force_start"');
    expect(out).toContain('data-action="start_anyway"');
    expect(out.match(/data-action="force_start"/g)!.length).toBe(out.match(/data-action="start_anyway"/g)!.length);
    expect(view({ tasks: [task({ ...limit, forceable: false })] }).waiting.rows[0].forceable).toBe(false);
  });
});

describe('R-11: Declared row sheet', () => {
  it('opens Depends on / Set by / Why with the blocker next step primary and a reasoned Remove', () => {
    const r = waitingRow(declared({ blockerStatus: 'pending' }), { reason: 'declared', blockerId: 'a', blockerStatus: 'pending', setBy: 'Its agent', why: 'needs the index' });
    const out = renderToStaticMarkup(h(DependencyBody, { row: r, reason: "", onReason: noop, busy: false, error: null, onRemove: noop }));
    for (const label of ['Depends on', 'Set by', 'Why']) expect(out).toContain(label);
    expect(out).toContain('Its agent');
    expect(out).toContain('needs the index');
    expect(out).toContain('Start it');
    expect(out).toMatch(/btn-primary[^"]*"[^>]*href="\/app\/tasks\/a"|href="\/app\/tasks\/a"[^>]*btn-primary/);
    expect(out).toMatch(/disabled[^>]*data-testid="queue-remove-dependency"|data-testid="queue-remove-dependency"[^>]*disabled/);
  });
});

describe('R-12: every action also exists on the task page', () => {
  it('the task page gets the same wait and force offer through the shared task actions', () => {
    const actions = src('lib/task-actions.ts');
    expect(actions).toContain('queueWait?: import(\'@buildd/shared\').QueueWait');
    expect(actions).toContain('force?: ForceOffer');
    expect(src('app/api/tasks/[id]/waiting/route.ts')).toContain('QueueWait');
  });
});

describe('R-13: labels over sentences, no internal names', () => {
  it('uses no internal vocabulary in the rendered board', () => {
    const out = html({ slots: 1, lanes: [lane([holder()])], tasks: [task(laneWait(1)), task(limit), task(declared())] });
    for (const bad of ['migration', 'slot_wait', 'workspace_cap', 'serial_lane', 'coordination_gate', 'hardSurface', 'pathClaim', 'undefined', 'NaN', '—']) expect(out).not.toContain(bad);
  });
});

describe('R-14: one bounded read, 50 rows a page', () => {
  it('reads once, bounded, and pages the Waiting table by 50', async () => {
    const d = deps({ rows: mock(async () => Array.from({ length: 120 }, (_, i) => row(i))) });
    const v = await loadHealthQueue(scope, d);
    expect(d.rows).toHaveBeenCalledTimes(1);
    expect((d.rows as any).mock.calls[0][0]).toEqual({ workspaceIds: ['w1'], limit: HEALTH_QUEUE_LIMIT });
    expect(d.waits).toHaveBeenCalledTimes(1);
    expect(v.waiting.rows).toHaveLength(50);
    expect(v.waiting.pages).toBe(3);
  });
});

describe('R-15: ships after Overlap scheduling lane order and claim-order presentation', () => {
  it('reads rows in claim order and lanes from the stored lane order the claim route uses', () => {
    const s = src('lib/health-queue.ts');
    expect(s).toContain('buildRunnerQueueQuery');
    expect(s).toContain('loadLanes');
    expect(s).toMatch(/claim-order|stored order/);
  });
});

describe('AC-1: tiles read 4/6, 2, 9, 1 and link to rows', () => {
  it('counts', () => {
    const tasks = [
      task(slot), task(slot),
      ...Array.from({ length: 9 }, () => task(limit)),
      task(parkedWait),
    ];
    const v = view({ running: 4, slots: 6, teamBusy: 4, tasks });
    expect([`${v.tiles.running}/${v.tiles.slots}`, v.tiles.ready, v.tiles.waiting, v.tiles.parked]).toEqual(['4/6', 2, 9, 1]);
    const out = html({ running: 4, slots: 6, teamBusy: 4, tasks });
    expect(out).toContain('4/6');
    expect(out).toContain('href="#queue-waiting"');
  });
});

describe('AC-2: idle slots with an unserved ready task alert with the cause', () => {
  it('names idle slots and cause', () => {
    const v = view({ slots: 3, teamBusy: 1, tasks: [task({ kind: 'slot', noRunnerReason: 'no reviewer runner online' })] });
    expect(v.alert).toBe('2 idle slots, 1 task could start · no reviewer runner online');
    expect(view({ slots: 4, teamBusy: 0, tasks: [task(limit)] }).alert).toBeNull();
  });
});

describe('AC-3: Declared names A, Lane reads "Schema lane · 3rd"', () => {
  it('badges', () => {
    const b = task(declared());
    const c = task(laneWait(3));
    const rows = view({ tasks: [b, c] }).waiting.rows;
    const rowB = rows.find(r => r.id === b.id)!;
    const rowC = rows.find(r => r.id === c.id)!;
    expect([rowB.badge, rowB.blockedBy, rowB.blockerId]).toEqual(['Declared', 'Task A', 'a']);
    expect([rowC.badge, rowC.blockedBy]).toEqual(['Lane', 'Schema lane · 3rd']);
  });
});

describe('AC-4: stuck lane holder alerts and offers Release', () => {
  it('after 24 hours without PR activity', async () => {
    const quiet = new Date(NOW - 30 * HOUR);
    const read = { releasedTaskIds: new Set<string>(), lanes: new Map([['w1', new Map([['migration', { workspaceId: 'w1', lane: 'migration', members: [
      { taskId: 'h', claimableSince: null, priority: 0, createdAt: new Date(NOW), heldAt: quiet, holding: true, ready: false, status: 'completed', prNumber: 9, prUrl: 'u', lastActivityAt: quiet },
    ] }]])]]) };
    const v = await loadHealthQueue(scope, deps({ lanes: mock(async () => read as any), titles: mock(async () => new Map([['h', 'Add column']])) }));
    expect(v.alert).toContain('Schema lane stuck 30h');
    expect(v.lanes[0].stuckFor).toBe('30h');
    expect(laneBody(v.lanes[0])).toContain('queue-lane-release');
    const fresh = view({ lanes: [lane([holder({ stuckSince: null })])] });
    expect(fresh.alert).toBeNull();
    expect(laneBody(fresh.lanes[0])).not.toContain('queue-lane-release');
  });
});

describe('AC-5: no lane in use, no Lanes card', () => {
  it('hides the card', () => {
    expect(view().lanes).toEqual([]);
    expect(view({ lanes: [lane([])] }).lanes).toEqual([]);
    expect(html()).not.toContain('queue-lanes');
  });
});

describe('AC-6: lane panel order matches the claim route', () => {
  it('holder first with its state, waiters in lane order', () => {
    const v = view({ lanes: [lane([waiter('w1', 'First'), holder(), waiter('w2', 'Second')])] });
    const l = v.lanes[0];
    expect(l.name).toBe('Schema');
    expect(l.holder).toMatchObject({ taskId: 'h', state: 'Running', position: null });
    expect(l.waiters.map(w => [w.taskId, w.position])).toEqual([['w1', 1], ['w2', 2]]);
  });
});

describe('AC-7: Force start sheet and call', () => {
  it('Limit row offers Force start and confirms through the shared refusal with the reasons digest', () => {
    expect(rowAction(waitingRow(limit))).toBe('force_start');
    const sheet = src('app/app/(protected)/health/queue/QueueStartSheet.tsx');
    expect(sheet).toContain('CoordinationRefusal');
    expect(sheet).toContain('reasonsDigest: refusal.reasonsDigest');
    expect(sheet).toContain('useTaskStart');
    expect(startStatusLine({ status: 'waiting', forced: { forceId: 'f', gates: ['Mission concurrency limit'], railsRemaining: [], expiresAt: '' } as any })).toBe('Force start requested.');
  });
  it('a non-forceable Limit and a Lane row offer no Force start; Declared offers Start anyway (r8 R-20, not Force start)', () => {
    expect(rowAction(waitingRow({ ...limit, forceable: false }))).toBeNull();
    expect(rowAction(waitingRow(laneWait(1)))).toBeNull();
    expect(rowAction(waitingRow(declared(), { reason: 'declared' }))).toBe('start_anyway');
    expect(view({ tasks: [task(laneWait(1)), task(declared())] }).waiting.rows.every(r => !r.forceable)).toBe(true);
  });
});

describe('AC-8: Declared row sheet', () => {
  it('blocker next step is primary, Remove requires a reason', () => {
    const r = waitingRow(declared({ blockerStatus: 'completed' }), { reason: 'declared', blockerId: 'a', blockerStatus: 'completed' });
    const without = renderToStaticMarkup(h(DependencyBody, { row: r, reason: "", onReason: noop, busy: false, error: null, onRemove: noop }));
    expect(without).toContain('Merge its PR');
    expect(without).toMatch(/disabled[^>]*data-testid="queue-remove-dependency"|data-testid="queue-remove-dependency"[^>]*disabled/);
    const withReason = renderToStaticMarkup(h(DependencyBody, { row: r, reason: "split", onReason: noop, busy: false, error: null, onRemove: noop }));
    expect(withReason).not.toMatch(/disabled=""[^>]*data-testid="queue-remove-dependency"/);
  });
});

describe('AC-9: one pending task gives one reason everywhere', () => {
  it('the Queue row carries the wait the shared read gave, and the other surfaces read the same module', async () => {
    const wait = laneWait(2);
    const v = await loadHealthQueue(scope, deps({ rows: mock(async () => [row(1)]), waits: mock(async () => new Map([['r-1', wait]])) }));
    expect(v.waiting.rows[0].wait).toEqual(wait);
    expect(v.waiting.rows[0].blockedBy).toBe(queueWaitBlockedBy(wait, NOW));
    for (const f of ['lib/explain.ts', 'lib/claim-order-queue.ts', 'lib/task-actions.ts']) expect(src(f)).toMatch(/QueueWait|queue-wait-load/);
    expect(src('lib/claim-order-queue.ts')).toContain('loadQueueWaitMap');
    expect(src('lib/health-queue.ts')).toContain('loadQueueWaitMap');
  });
});

describe('AC-10: 400 pending tasks, one bounded read, 50 rows, exact tiles', () => {
  it('pages and counts exactly', async () => {
    const d = deps({ rows: mock(async () => Array.from({ length: 400 }, (_, i) => row(i))) });
    const v = await loadHealthQueue(scope, d);
    expect(d.rows).toHaveBeenCalledTimes(1);
    expect(v.tiles.waiting).toBe(400);
    expect(v.waiting.total).toBe(400);
    expect(v.waiting.rows).toHaveLength(50);
    expect(v.waiting.pages).toBe(8);
    expect(v.truncated).toBe(false);
    expect(html({ tasks: Array.from({ length: 120 }, () => task(limit)) })).toContain('queue-pager');
  });
});
