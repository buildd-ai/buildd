/**
 * Health › Queue's render on the shared Health components (spec 4bc3e70e r8):
 * QueueTiles link to their rows and Running reads the Capacity numbers (AC-1,
 * AC-14), QueueRow rows carry one reason and its words (AC-3), Queued rows are
 * DeliveryRow rows in claim order (AC-14), Lanes only when one is in use with
 * each holder's StageMeter (AC-5, AC-6), a row's action is Force start on a
 * forceable Limit and Start anyway on a Dependency (AC-13), and 400 pending
 * tasks render 50 rows a page with exact tiles (AC-10).
 */
import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HealthQueueLane, HealthQueueWaitingRow, QueueWait } from '@buildd/shared';
import { buildHealthQueueView, type HealthQueueTaskInput } from '@/lib/health-queue-view';
import QueueBoard from './QueueBoard';
import { DependencyBody, LaneBody, blockerNextStep } from './QueueSheets';
import { queueTilesProps, readyDelivery, rowAction, runningOf } from './queue-board-model';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const noop = () => {};
let n = 0;
const t = (wait: QueueWait | null, title?: string, missionTitle: string | null = null): HealthQueueTaskInput => {
  n += 1;
  return { id: `t-${n}`, title: title ?? `Task ${n}`, workspaceId: 'ws-1', missionTitle, createdAt: new Date(NOW - n * 3600_000).toISOString(), wait };
};

type ViewInput = Parameters<typeof buildHealthQueueView>[0];
const viewOf = (over: Partial<ViewInput>) => buildHealthQueueView({ now: NOW, running: 0, slots: 0, teamBusy: 0, tasks: [], lanes: [], filter: 'all', page: 1, truncated: false, missions: [], ...over });
function render(over: Partial<ViewInput>) {
  return renderToStaticMarkup(<QueueBoard view={viewOf(over)} now={NOW} onFilter={noop} onPage={noop} onOpenLane={noop} onStart={noop} />);
}
/** Only the desktop list, so a row is counted once. */
const desktopRows = (html: string) => html.match(/data-testid="queue-row" data-layout="desktop"/g) ?? [];
const tile = (html: string, id: string) => html.match(new RegExp(`<a[^>]*data-testid="${id}"[^>]*>.*?</a>`))?.[0] ?? '';

const lanes = [{ workspaceId: 'ws-1', lane: 'migration', members: [
  { taskId: 'h', title: 'Add column', holding: true, status: 'in_progress', prNumber: null, since: new Date(NOW - 2 * 3600_000).toISOString(), stuckSince: null },
  { taskId: 'w', title: 'Rename table', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
] }];

const slot: QueueWait = { kind: 'slot' };
const parked: QueueWait = { kind: 'start_time', startAt: new Date(NOW + 3600_000).toISOString() };
const limit: QueueWait = { kind: 'limit', limit: 'mission_cap', forceable: true };

describe('QueueBoard', () => {
  it('never shows running against zero or fewer slots as a fraction', () => {
    const html = render({ running: 1, slots: 0 });
    expect(html).not.toContain('1/0');
    expect(html).toContain('slot total unknown');
    expect(render({ running: 3, slots: 2 })).not.toContain('3/2');
    expect(render({ running: 4, slots: 6 })).toContain('4/6');
  });
  it('a truncated read says so as a label, and only then', () => {
    expect(render({ truncated: true })).toContain('Partial queue. Counts are minimums.');
    expect(render({})).not.toContain('data-testid="queue-truncated"');
  });

  it('AC-1: 4 running, 2 ready, 9 waiting and 1 parked across 6 slots read 4/6, 2, 9, 1, each linking to its rows', () => {
    const waiting = [
      ...Array.from({ length: 3 }, (_, i) => t({ kind: 'lane', lane: 'migration', position: i + 1 })),
      ...Array.from({ length: 2 }, () => t(limit)),
      ...Array.from({ length: 4 }, () => t({ kind: 'declared', blockerId: 'a', blockerTitle: 'Export job', count: 1 })),
    ];
    const html = render({ running: 4, slots: 6, teamBusy: 6, tasks: [t(slot), t(slot), ...waiting, t(parked)] });
    expect(tile(html, 'queue-tile-running')).toContain('4/6');
    expect(tile(html, 'queue-tile-running')).toContain('href="/app/health/runners"');
    expect(tile(html, 'queue-tile-queued')).toContain('>2<');
    expect(tile(html, 'queue-tile-queued')).toContain('href="#queue-ready"');
    expect(tile(html, 'queue-tile-blocked')).toContain('>9<');
    expect(tile(html, 'queue-tile-blocked')).toContain('href="#queue-waiting"');
    expect(tile(html, 'queue-tile-blocked')).toContain('3 lane · 2 limit · 4 dependency');
    expect(tile(html, 'queue-tile-scheduled')).toContain('>1<');
    expect(tile(html, 'queue-tile-scheduled')).toContain('href="#queue-parked"');
    // Each tile's rows are on the page.
    for (const id of ['queue-ready', 'queue-waiting', 'queue-parked']) expect(html).toContain(`id="${id}"`);
    // Two columns on a phone, four on desktop.
    expect(html).toContain('data-layout="phone"');
    expect(html).toContain('data-layout="desktop"');
  });

  it('AC-14: 3 of 9 slots busy read 3 and /9 slots in use, the Capacity pair; 3 ready rows in claim order', () => {
    const view = viewOf({ running: 3, slots: 9, teamBusy: 3, tasks: [t(slot, 'First in line'), t(slot, 'Second in line'), t(slot, 'Third in line')] });
    expect(runningOf(view.tiles)).toEqual({ used: 3, total: 9 });
    const html = renderToStaticMarkup(<QueueBoard view={view} now={NOW} onFilter={noop} onPage={noop} onOpenLane={noop} onStart={noop} />);
    expect(tile(html, 'queue-tile-running')).toContain('3/9');
    expect(tile(html, 'queue-tile-running')).toContain('/9 slots in use');
    const order = ['First in line', 'Second in line', 'Third in line'].map(x => html.indexOf(`>${x}<`));
    expect(order.every(i => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/data-testid="delivery-row"/g)).toHaveLength(3);
    // Idle slots go to the first rows in claim order.
    expect(view.ready.map(r => r.note)).toEqual(['Starts now', 'Starts now', 'Starts now']);
  });

  it('R-4: the shared IdleAlert when slots idle while work could start; otherwise only the phone line', () => {
    const html = render({ slots: 2, tasks: [t({ kind: 'slot', noRunnerReason: 'no reviewer runner online' })] });
    expect(html).toContain('data-testid="idle-alert"');
    expect(html).toContain('2 idle slots, 1 task could start.');
    expect(html).toContain('no reviewer runner online');
    const calm = render({ slots: 0, tasks: [] });
    expect(calm).not.toContain('idle-alert');
    expect(calm).toMatch(/data-testid="queue-calm"[^>]*md:hidden|md:hidden[^"]*"[^>]*>Nothing held/);
  });

  it('AC-5: no Lanes card when no lane is in use; one with the holder\'s StageMeter when a lane is', () => {
    expect(render({})).not.toContain('queue-lanes');
    const html = render({ lanes });
    expect(html).toContain('data-testid="queue-lanes"');
    expect(html).toContain('Add column');
    expect(html).toContain('data-testid="queue-lane-meter"');
    expect(html).toContain('data-state="build"');
    expect(html).toContain('+1');
  });

  it('AC-3: B declared on A names A; C third in the schema lane reads Schema lane · 3rd', () => {
    const html = render({ tasks: [
      t({ kind: 'declared', blockerId: 'a', blockerTitle: 'A', count: 1 }, 'B'),
      t({ kind: 'lane', lane: 'migration', position: 3 }, 'C'),
    ] });
    const rows = html.split('data-testid="queue-blocked-row"').slice(1);
    const b = rows.find(r => r.includes('>B<'))!;
    const c = rows.find(r => r.includes('>C<'))!;
    expect(b).toMatch(/data-testid="queue-reason"[^>]*>.*?Dependency<\/span>/);
    expect(b).toContain('>A<');
    expect(c).toMatch(/data-testid="queue-reason"[^>]*>.*?Lane<\/span>/);
    expect(c).toContain('Schema lane · 3rd');
  });

  it('R-6: Lane, Limit, Dependency order, and filter chips with their counts', () => {
    const html = render({ tasks: [
      t({ kind: 'declared', blockerId: 'a', blockerTitle: 'A', count: 1 }, 'Dep'),
      t(limit, 'Lim'),
      t({ kind: 'lane', lane: 'migration', position: 1 }, 'Lan'),
    ] });
    const desktop = html.slice(html.indexOf('data-testid="queue-blocked-desktop"'));
    expect(['Lan', 'Lim', 'Dep'].map(x => desktop.indexOf(`>${x}<`))).toEqual([...['Lan', 'Lim', 'Dep'].map(x => desktop.indexOf(`>${x}<`))].sort((a, b) => a - b));
    for (const [value, count] of [['all', 3], ['lane', 1], ['limit', 1], ['declared', 1]] as const) {
      expect(html).toMatch(new RegExp(`data-value="${value}"[^>]*>.*?<span class="font-mono text-text-muted">${count}</span>`));
    }
  });

  it('AC-13: Force start only on a forceable Limit, Start anyway on a Dependency, nothing on a Lane', () => {
    const html = render({ tasks: [
      t({ kind: 'declared', blockerId: 'a', blockerTitle: 'A', count: 1 }),
      t({ kind: 'lane', lane: 'migration', position: 1 }),
      t(limit),
      t({ kind: 'limit', limit: 'budget', forceable: false }),
    ] });
    // Phone and desktop lists each carry the actions once.
    expect(html.match(/data-action="force_start"/g)).toHaveLength(2);
    expect(html.match(/data-action="start_anyway"/g)).toHaveLength(2);
  });

  it('AC-10: 400 pending tasks render 50 rows with paging, and the tiles stay exact', () => {
    const many = Array.from({ length: 400 }, (_, i) => t(i % 2 ? limit : { kind: 'declared', blockerId: 'a', blockerTitle: 'A', count: 1 }));
    const view = viewOf({ tasks: many });
    expect(view.tiles.waiting).toBe(400);
    const html = renderToStaticMarkup(<QueueBoard view={view} now={NOW} onFilter={noop} onPage={noop} onOpenLane={noop} onStart={noop} />);
    expect(desktopRows(html)).toHaveLength(50);
    expect(html).toContain('data-testid="queue-pager"');
    expect(html).toContain('1/8');
    expect(tile(html, 'queue-tile-blocked')).toContain('>400<');
    expect(render({ tasks: many.slice(0, 3) })).not.toContain('queue-pager');
  });

  it('no internal names in what it renders', () => {
    const html = render({ slots: 1, lanes, tasks: [t({ kind: 'lane', lane: 'migration', position: 1 }), t(limit)] });
    for (const word of ['slot_wait', 'workspace_cap', 'serial_lane', 'dep_declared', '—']) expect(html).not.toContain(word);
  });
});

describe('queue-board-model', () => {
  it('the tiles take the view\'s numbers, with Declared as Dependency', () => {
    const p = queueTilesProps(viewOf({ running: 1, slots: 2, tasks: [t({ kind: 'declared', blockerId: 'a', count: 1 })] }));
    expect(p.running).toEqual({ used: 1, total: 2 });
    expect(p.blocked).toEqual({ lane: 0, limit: 0, dependency: 1 });
  });

  it('a Queued row is a DeliveryRow not yet started, tagged with its mission', () => {
    const d = readyDelivery({ id: 'x', title: 'X', missionTitle: 'Health', createdAt: new Date(NOW).toISOString(), note: 'Starts now', noRunner: false });
    expect(d).toMatchObject({ href: '/app/tasks/x', meter: { state: 'queued', stage: 'build' }, missionTitle: 'Health', updatedAt: NOW });
  });

  it('row actions follow R-20', () => {
    const base = viewOf({ tasks: [t(limit), t({ kind: 'limit', limit: 'budget', forceable: false }), t({ kind: 'declared', blockerId: 'a', count: 1 }), t({ kind: 'lane', lane: 'migration', position: 1 })] }).waiting.rows;
    expect(Object.fromEntries(base.map(r => [`${r.reason}:${r.forceable}`, rowAction(r)]))).toEqual({
      'lane:false': null, 'limit:true': 'force_start', 'limit:false': null, 'declared:false': 'start_anyway',
    });
  });
});

const lane: HealthQueueLane = {
  workspaceId: 'ws-1', lane: 'migration', name: 'Schema', stuckFor: '26h',
  holder: { taskId: 'h', title: 'Add column', position: null, state: 'PR open', meter: { state: 'verify' }, age: '30h', prNumber: 9 },
  waiters: [
    { taskId: 'w1', title: 'First', position: 1, state: null, meter: null, age: '5h', prNumber: null },
    { taskId: 'w2', title: 'Second', position: 2, state: null, meter: null, age: '1h', prNumber: null },
  ],
};

describe('LaneBody (AC-4, AC-6)', () => {
  it('the holder first with its state, then waiters in position order; Release for a stuck lane', () => {
    const html = renderToStaticMarkup(<LaneBody lane={lane} confirming={false} busy={false} error={null} onRelease={noop} onConfirm={noop} onCancel={noop} />);
    const holder = html.indexOf('Add column');
    const first = html.indexOf('First');
    const second = html.indexOf('Second');
    expect(holder).toBeGreaterThan(-1);
    expect(holder).toBeLessThan(first);
    expect(first).toBeLessThan(second);
    expect(html).toContain('PR open');
    // AC-6: the holder carries its StageMeter, ahead of the waiters.
    const meter = html.indexOf('data-testid="queue-lane-holder-meter"');
    expect(meter).toBeGreaterThan(-1);
    expect(meter).toBeLessThan(first);
    expect(html).toContain('data-state="verify"');
    expect(html).toContain('1st');
    expect(html).toContain('2nd');
    expect(html).toContain('queue-lane-release');
  });

  it('no Release for a lane that is moving', () => {
    const html = renderToStaticMarkup(<LaneBody lane={{ ...lane, stuckFor: null }} confirming={false} busy={false} error={null} onRelease={noop} onConfirm={noop} onCancel={noop} />);
    expect(html).not.toContain('queue-lane-release');
  });
});

const limitRow: HealthQueueWaitingRow = {
  id: 't-x', title: 'Ship it', workspaceId: 'ws-1', missionTitle: null, reason: 'limit', badge: 'Limit', blockedBy: 'Mission budget',
  blockerId: null, blockerStatus: null, setBy: null, why: null, lane: null, age: '1h', forceable: true,
  wait: { kind: 'limit', limit: 'mission_budget', forceable: true },
};

describe('DependencyBody (AC-8)', () => {
  const row: HealthQueueWaitingRow = {
    ...limitRow, reason: 'declared', badge: 'Declared', blockedBy: 'Add the index', blockerId: 'a', blockerStatus: 'pending',
    setBy: 'Its agent', why: 'needs the index', forceable: false,
    wait: { kind: 'declared', blockerId: 'a', blockerTitle: 'Add the index', blockerStatus: 'pending', count: 1 },
  };

  it("the blocker's next step is primary; Remove is disabled until there is a reason", () => {
    const html = renderToStaticMarkup(<DependencyBody row={row} reason="" onReason={noop} busy={false} error={null} onRemove={noop} />);
    expect(html).toContain('Depends on');
    expect(html).toContain('Set by');
    expect(html).toContain('Its agent');
    expect(html).toContain('needs the index');
    expect(html).toMatch(/btn-primary[^"]*"[^>]*href="\/app\/tasks\/a"|href="\/app\/tasks\/a"[^>]*btn-primary/);
    expect(html).toContain('Start it');
    expect(html).toMatch(/disabled[^>]*data-testid="queue-remove-dependency"|data-testid="queue-remove-dependency"[^>]*disabled/);
    const ready = renderToStaticMarkup(<DependencyBody row={row} reason="split" onReason={noop} busy={false} error={null} onRemove={noop} />);
    expect(ready).not.toMatch(/disabled=""[^>]*data-testid="queue-remove-dependency"/);
  });

  it('next steps by blocker status', () => {
    expect(blockerNextStep('in_progress')).toBe('Watch it run');
    expect(blockerNextStep('completed')).toBe('Merge its PR');
    expect(blockerNextStep('failed')).toBe('Retry it');
    expect(blockerNextStep(null)).toBe('Open it');
  });
});
