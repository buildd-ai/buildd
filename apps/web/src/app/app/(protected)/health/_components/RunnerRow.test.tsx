import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import { RunnerRow } from './RunnerRow';

const NOW = Date.parse('2026-10-25T12:00:00Z');

const runner = (over: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat => ({
  id: 'r1',
  accountName: 'Studio',
  lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
  maxConcurrentWorkers: 4,
  activeWorkerCount: 0,
  runnerClass: 'personal',
  mine: true,
  ...over,
} as RunnerHeartbeat);

const html = (props: Partial<Parameters<typeof RunnerRow>[0]> = {}) =>
  renderToStaticMarkup(<RunnerRow runner={runner()} fleetRow={null} online now={NOW} {...props} />);

describe('RunnerRow (R-14, R-15, AC-10)', () => {
  it('is collapsed by default: a Details button and no slot detail', () => {
    const h = html();
    expect(h).toContain('Details');
    expect(h).not.toContain('health-runner-detail');
  });

  it('working: busy count shown with pips', () => {
    expect(html({ runner: runner({ activeWorkerCount: 2 }) })).toContain('2/4');
  });

  it('working names the work, masking a teammate\'s run from a member', () => {
    const fleetRow = { id: 'r1', name: 'Studio', maxSlots: 4, online: true, slots: [
      { index: 0, worker: { label: 'build', name: 'Fix the thing', mine: true }, last: null },
      { index: 1, worker: { label: 'x', name: 'Secret thing', mine: false }, last: null },
    ] } as never;
    const h = html({ runner: runner({ activeWorkerCount: 2 }), fleetRow });
    expect(h).toContain('Working on Fix the thing, A teammate&#x27;s work');
    expect(h).not.toContain('Secret thing');
    expect(html({ runner: runner({ activeWorkerCount: 2 }), fleetRow, seesTeamWork: true })).toContain('Secret thing');
  });

  it('idle with work that could start here links to the queue', () => {
    const h = html({ workQueuedHere: 3 });
    expect(h).toContain('3 tasks queued could start here');
    expect(h).toContain('href="/app/health/queue"');
  });

  it('idle with nothing queued says nothing extra', () => {
    expect(html()).not.toContain('health-runner-state-line');
  });

  it('a busy runner does not claim work could start here', () => {
    expect(html({ runner: runner({ activeWorkerCount: 4 }), workQueuedHere: 3 })).not.toContain('could start here');
  });

  it('paused with 2 running reads Paused · 2 finishing (spec 97b1bd0b AC-12)', () => {
    const r = runner({ activeWorkerCount: 2, pause: { held: true, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date(NOW).toISOString() } });
    const h = html({ runner: r });
    expect(h).toContain('Paused · 2 finishing');
    expect(h).toContain('data-paused="true"');
    expect(h).not.toContain('Working on');
  });

  it('offline with a saved Pause says it applies on reconnect', () => {
    const r = runner({ pause: { held: false, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date(NOW).toISOString() } });
    expect(html({ runner: r, online: false })).toContain('→ Paused on reconnect');
  });

  it('expanded: an owner gets Pause next to the stepper', () => {
    const r = runner({ slots: { desired: 4, origin: 'machine', setBy: null, setAt: null, canEdit: true }, pause: { held: false, desired: false, origin: 'machine', setBy: null, setAt: null } });
    const h = html({ runner: r, health: { loading: false, expanded: true } });
    expect(h).toContain('data-testid="runner-pause-toggle"');
    expect(h).toContain('>Pause<');
  });

  it('offline with a saved slot change says it applies when it checks in', () => {
    const r = runner({ slots: { desired: 6, origin: 'dashboard', setBy: 'Max', setAt: new Date(NOW).toISOString(), canEdit: true } as never });
    const h = html({ runner: r, online: false });
    expect(h).toContain('offline');
    expect(h).toContain('A slot change is saved and applies when it checks in.');
  });

  it('expanded: Owner is its own fact, with the stepper for an owner/admin and a Failures link', () => {
    const r = runner({ slots: { desired: null, origin: null, setBy: null, setAt: null, canEdit: true } as never });
    const h = html({ runner: r, health: { loading: false, expanded: true } });
    expect(h).toContain('Hide');
    expect(h).toContain('health-runner-owner');
    expect(h).toContain('>Owner<');
    expect(h).toContain('runner-slots-minus');
    expect(h).toContain('Claude:');
    expect(h).toContain('Codex:');
  });

  it('no stepper without edit rights', () => {
    const h = html({ health: { loading: false, expanded: true } });
    expect(h).not.toContain('runner-slots-minus');
  });

  it('never uses a fixed-width layout that can overflow a phone', () => {
    expect(html({ health: { loading: false, expanded: true } })).not.toMatch(/min-w-\[|w-\[\d{3,}px\]/);
  });

  const pips = (h: string) => ({
    total: (h.match(/inline-block w-1\.5 h-1\.5 rounded-full/g) ?? []).length,
    filled: (h.match(/bg-status-success/g) ?? []).length,
  });

  it('pips: one per slot, filled for each running, with n/cap', () => {
    const h = html({ runner: runner({ activeWorkerCount: 2, maxConcurrentWorkers: 4 }) });
    expect(h).toContain('2/4');
    expect(h).not.toContain('slots in use');
    // glow-dot-success is the online dot, not a pip
    expect(pips(h)).toEqual({ total: 4, filled: 2 });
  });

  it('0/0: no pips, still reads 0/0', () => {
    const h = html({ runner: runner({ activeWorkerCount: 0, maxConcurrentWorkers: 0 }) });
    expect(h).toContain('0/0');
    expect(pips(h).total).toBe(0);
  });

  it('0/n: all pips empty', () => {
    const h = html({ runner: runner({ activeWorkerCount: 0, maxConcurrentWorkers: 3 }) });
    expect(h).toContain('0/3');
    expect(pips(h)).toEqual({ total: 3, filled: 0 });
  });

  it('sandbox: warning icon (with accessible text) only when not sandboxed', () => {
    const off = html({ runner: runner({ sandboxEnabled: false, mountAllowlistEnforced: false }) });
    expect(off).toContain('health-runner-sandbox-warning');
    expect(off).toContain('aria-label="Not sandboxed"');
    expect(off).toContain('sr-only');
  });

  it('sandbox: nothing, not even a text chip, for a sandboxed or unknown runner', () => {
    for (const over of [{ sandboxEnabled: true, mountAllowlistEnforced: true }, { sandboxEnabled: null }]) {
      const h = html({ runner: runner(over as never) });
      expect(h).not.toContain('health-runner-sandbox-warning');
      expect(h).not.toMatch(/sandboxed|sandbox off|sandbox partly on/i);
    }
  });

  const busyRow = (over: object = {}) => ({ id: 'r1', name: 'Studio', maxSlots: 2, online: true, slots: [
    { index: 0, worker: { label: 'build', name: 'Fix the thing', mine: true, missionId: 'm-1', ...over }, last: null },
    { index: 1, worker: null, last: null },
  ] } as never);

  it('Running line traces the first running task to its mission when active', () => {
    const h = html({ runner: runner({ activeWorkerCount: 1 }), fleetRow: busyRow() });
    expect(h).toContain('health-runner-running');
    expect(h).toContain('Running: Fix the thing');
    expect(h).toContain('href="/app/missions/m-1"');
  });

  it('Running line: no mission link without a mission; a waiting run still shows', () => {
    expect(html({ runner: runner({ activeWorkerCount: 1 }), fleetRow: busyRow({ missionId: null }) })).not.toContain('/app/missions/');
    expect(html({ runner: runner({ activeWorkerCount: 1 }), fleetRow: busyRow({ question: 'Which?' }) })).toContain('Waiting: Fix the thing');
  });

  it('Running line: absent when idle; masks a teammate\'s task and mission', () => {
    const idle = { id: 'r1', name: 'Studio', maxSlots: 2, online: true, slots: [{ index: 0, worker: null, last: null }] } as never;
    expect(html({ fleetRow: idle })).not.toContain('health-runner-running');
    const h = html({ runner: runner({ activeWorkerCount: 1 }), fleetRow: busyRow({ mine: false, name: 'Secret' }) });
    expect(h).not.toContain('Secret');
    expect(h).not.toContain('/app/missions/');
  });

  it('expanded: the stepper can step down to 0 slots', () => {
    const r = runner({ maxConcurrentWorkers: 1, slots: { desired: 1, origin: 'machine', setBy: null, setAt: null, canEdit: true } as never });
    const h = html({ runner: r, health: { loading: false, expanded: true } });
    expect(h).toMatch(/runner-slots-minus[^>]*>/);
    expect(h).not.toMatch(/disabled=""[^>]*data-testid="runner-slots-minus"|data-testid="runner-slots-minus"[^>]*disabled=""/);
  });
});
