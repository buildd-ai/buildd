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

  it('working: busy count shown', () => {
    expect(html({ runner: runner({ activeWorkerCount: 2 }) })).toContain('2 of 4 slots in use');
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
});
