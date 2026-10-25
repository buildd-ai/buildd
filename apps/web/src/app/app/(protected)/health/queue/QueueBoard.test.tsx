/**
 * Health › Queue's render (spec "Health › Queue"): tiles link to their rows,
 * the alert line, Lanes only when one is in use, one badge per waiting row,
 * Force start only on forceable Limit rows, and the sheet bodies (AC-6 to AC-8).
 */
import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HealthQueueLane, HealthQueueWaitingRow, QueueWait } from '@buildd/shared';
import { buildHealthQueueView, type HealthQueueTaskInput } from '@/lib/health-queue-view';
import QueueBoard from './QueueBoard';
import { DependencyBody, ForceStartBody, LaneBody, blockerNextStep, forceStateOf } from './QueueSheets';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const noop = () => {};
let n = 0;
const t = (wait: QueueWait | null, title?: string): HealthQueueTaskInput => {
  n += 1;
  return { id: `t-${n}`, title: title ?? `Task ${n}`, workspaceId: 'ws-1', missionTitle: null, createdAt: new Date(NOW - n * 3600_000).toISOString(), wait };
};

function render(over: Parameters<typeof buildHealthQueueView>[0] extends infer I ? Partial<I> : never) {
  const view = buildHealthQueueView({ now: NOW, running: 0, slots: 0, teamBusy: 0, tasks: [], lanes: [], filter: 'all', page: 1, truncated: false, missions: [], ...over });
  return renderToStaticMarkup(<QueueBoard view={view} onFilter={noop} onPage={noop} onOpenLane={noop} onOpenRow={noop} onForce={noop} />);
}

const lanes = [{ workspaceId: 'ws-1', lane: 'migration', members: [
  { taskId: 'h', title: 'Add column', holding: true, status: 'in_progress', prNumber: null, since: new Date(NOW - 2 * 3600_000).toISOString(), stuckSince: null },
  { taskId: 'w', title: 'Rename table', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
] }];

describe('QueueBoard', () => {
  it('a truncated read says so as a label, and only then', () => {
    expect(render({ truncated: true })).toContain('Partial queue. Counts are minimums.');
    expect(render({})).not.toContain('data-testid="queue-truncated"');
  });

  it('AC-1: four tiles that link to their rows', () => {
    const html = render({ running: 4, slots: 6, teamBusy: 6, tasks: [t({ kind: 'slot' }), t({ kind: 'slot' }), t({ kind: 'start_time', startAt: new Date(NOW + 3600_000).toISOString() })] });
    expect(html).toContain('4/6');
    expect(html).toContain('href="#queue-ready"');
    expect(html).toContain('href="#queue-waiting"');
    expect(html).toContain('href="#queue-parked"');
    expect(html).toContain('href="/app/health/runners"');
    expect(html).toContain('id="queue-ready"');
    expect(html).toContain('id="queue-parked"');
  });

  it('R-4: the alert when wrong; otherwise only the phone line', () => {
    expect(render({ slots: 2, tasks: [t({ kind: 'slot' })] })).toContain('2 idle slots, 1 task could start');
    const calm = render({ slots: 0, tasks: [] });
    expect(calm).not.toContain('queue-alert');
    expect(calm).toContain('Nothing held that could run');
    expect(calm).toMatch(/data-testid="queue-calm"[^>]*md:hidden|md:hidden[^"]*"[^>]*>Nothing held/);
  });

  it('AC-5: no Lanes card when no lane is in use; one when a lane is', () => {
    expect(render({})).not.toContain('queue-lanes');
    const html = render({ lanes });
    expect(html).toContain('queue-lanes');
    expect(html).toContain('Schema');
    expect(html).toContain('Add column');
    expect(html).toContain('1 waiting');
  });

  it('AC-3 and AC-7: badges, Blocked by, and Force start only on a forceable Limit', () => {
    const html = render({ tasks: [
      t({ kind: 'declared', blockerId: 'a', blockerTitle: 'Add the index', count: 1 }),
      t({ kind: 'lane', lane: 'migration', position: 3 }),
      t({ kind: 'limit', limit: 'mission_budget', forceable: true }),
    ] });
    expect(html).toContain('Declared');
    expect(html).toContain('Add the index');
    expect(html).toContain('Schema lane · 3rd');
    expect(html).toContain('Mission budget');
    expect(html.match(/data-testid="queue-force-start"/g)).toHaveLength(1);
    // Filter segments carry counts.
    expect(html).toContain('All 3');
    expect(html).toContain('Limit 1');
  });

  it('AC-10: a pager only past 50 rows', () => {
    const many = Array.from({ length: 120 }, () => t({ kind: 'limit', limit: 'mission_cap' }));
    const html = render({ tasks: many });
    expect(html.match(/data-testid="queue-waiting-row"/g)).toHaveLength(50);
    expect(html).toContain('queue-pager');
    expect(html).toContain('1/3');
    expect(render({ tasks: many.slice(0, 3) })).not.toContain('queue-pager');
  });

  it('no internal names in what it renders', () => {
    const html = render({ slots: 1, lanes, tasks: [t({ kind: 'lane', lane: 'migration', position: 1 }), t({ kind: 'limit', limit: 'mission_cap', forceable: true })] });
    for (const word of ['migration', 'slot_wait', 'workspace_cap', 'serial_lane', '—']) expect(html).not.toContain(word);
  });
});

const lane: HealthQueueLane = {
  workspaceId: 'ws-1', lane: 'migration', name: 'Schema', stuckFor: '26h',
  holder: { taskId: 'h', title: 'Add column', position: null, state: 'PR open', age: '30h', prNumber: 9 },
  waiters: [
    { taskId: 'w1', title: 'First', position: 1, state: null, age: '5h', prNumber: null },
    { taskId: 'w2', title: 'Second', position: 2, state: null, age: '1h', prNumber: null },
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

describe('ForceStartBody (AC-7)', () => {
  it('lists Skips and Still enforced from the /waiting contract', () => {
    const state = forceStateOf({
      reasonsDigest: 'd1', canForce: true,
      force: { kinds: ['mission_budget'], checklist: [{ gate: 'Mission budget', sentence: 'one task per hour' }], railsRemaining: ['Files another agent is editing stay locked.'] },
    });
    expect(state).toMatchObject({ kind: 'ready', digest: 'd1', kinds: ['mission_budget'] });
    const html = renderToStaticMarkup(<ForceStartBody row={limitRow} state={state} busy={false} onConfirm={noop} onClose={noop} />);
    expect(html).toContain('Skips');
    expect(html).toContain('Mission budget: one task per hour');
    expect(html).toContain('Still enforced');
    expect(html).toContain('Files another agent is editing stay locked.');
    expect(html).toContain('queue-force-confirm');
  });

  it('cannot confirm without a digest', () => {
    const html = renderToStaticMarkup(<ForceStartBody row={limitRow} state={forceStateOf({ canForce: false })} busy={false} onConfirm={noop} onClose={noop} />);
    expect(html).toMatch(/data-testid="queue-force-confirm"[^>]*disabled|disabled[^>]*data-testid="queue-force-confirm"/);
  });
});

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
