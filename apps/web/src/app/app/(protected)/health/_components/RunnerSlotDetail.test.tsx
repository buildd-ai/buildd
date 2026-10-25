import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetSnapshot } from '@buildd/shared';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import RunnerSlotDetail from './RunnerSlotDetail';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const runner = { id: 'r1', maxConcurrentWorkers: 2, activeWorkerCount: 1, lastHeartbeatAt: new Date(NOW).toISOString() } as RunnerHeartbeat;
const fleetRow = {
  id: 'r1', name: 'Studio', machine: null, maxSlots: 2, online: true,
  slots: [
    { index: 0, worker: { label: 'build', name: 'Fix the thing', mine: true, startedAt: new Date(NOW - 2 * 3_600_000).toISOString() }, last: null },
    { index: 1, worker: null, last: { label: 'older', failed: true, at: NOW - 3_600_000, mine: true } },
  ],
} as unknown as FleetSnapshot['runners'][number];

const html = (over: Partial<Parameters<typeof RunnerSlotDetail>[0]> = {}) =>
  renderToStaticMarkup(
    <RunnerSlotDetail fleetRow={fleetRow} runner={runner} online lastHeartbeatAt={runner.lastHeartbeatAt} now={NOW} seesTeamWork ownerLabel="personal" route={{ claude: 'subscription', codex: 'not set up' }} {...over} />,
  );

describe('RunnerSlotDetail', () => {
  it('Work is a bare label, not a sentence', () => {
    expect(html()).toContain('>Per slot<');
  });

  it('lists slots with their work and last run', () => {
    const h = html();
    expect(h).toContain('Working · Fix the thing');
    expect(h).toContain('Fix the thing · 2h');
    expect(h).toContain('Idle · last older (failed), 1h ago');
  });

  it('shows Owner, and the Claude/Codex login, as separate facts', () => {
    const h = html();
    expect(h).toContain('>Owner<');
    expect(h).toContain('personal');
    expect(h).toContain('Claude: subscription · Codex: not set up');
  });

  it('counts failed slots and links to Failures', () => {
    const h = html();
    expect(h).toContain('Failed: 1 slot');
    expect(h).toContain('href="/app/health/failures"');
  });

  it('says none failed when none did', () => {
    expect(html({ fleetRow: { ...fleetRow, slots: [fleetRow.slots[0]] } as never })).toContain('Failed: none');
  });

  it("hides a teammate's work name from someone who cannot see team work", () => {
    const row = { ...fleetRow, slots: [{ index: 0, worker: { label: 'x', name: 'Secret', mine: false }, last: null }] } as never;
    const h = html({ fleetRow: row, seesTeamWork: false });
    expect(h).not.toContain('Secret');
    expect(h).toContain("A teammate&#x27;s work");
  });
});
