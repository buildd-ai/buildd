/**
 * Settings → Runners leads with the fleet: each host runner online or
 * offline with busy/total slots (Home's SlotMeter), then the cloud runner.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetRunner, FleetSlot, FleetSnapshot } from '@buildd/shared';
import FleetOverview, { fleetOverviewHeadline } from './FleetOverview';

function slot(index: number, busy: boolean, question: string | null = null): FleetSlot {
  return {
    index,
    worker: busy ? {
      workerId: `w${index}`, taskId: `t${index}`, missionId: null, label: 'task', rest: '', roleSlug: null,
      roleName: null, roleColor: null, status: question ? 'waiting_input' : 'running', progress: null,
      startedAt: null, question,
    } : null,
    last: null,
    lane: { id: `l${index}`, bars: [] },
  };
}

function runner(id: string, name: string, busy: number, max: number, online = true, question = false): FleetRunner {
  return {
    id, name, machine: 'Linux · x64', maxSlots: max, online,
    slots: Array.from({ length: max }, (_, i) => slot(i, i < busy, question && i === 0 ? 'Which one?' : null)),
  };
}

function fleet(runners: FleetRunner[]): FleetSnapshot {
  const live = runners.reduce((n, r) => n + r.slots.filter(s => s.worker).length, 0);
  const capacity = runners.filter(r => r.online).reduce((n, r) => n + r.maxSlots, 0);
  return { runners, live, capacity, window: { from: 0, to: 0 } };
}

const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('FleetOverview', () => {
  it('lists each runner with online state and busy/total slots', () => {
    const html = renderToStaticMarkup(<FleetOverview fleet={fleet([runner('a', 'runner-1', 2, 4), runner('b', 'runner-2', 0, 4, false)])} />);
    expect(html.match(/data-testid="fleet-runner-row"/g)?.length).toBe(2);
    expect(html).toContain('data-online="true"');
    expect(html).toContain('data-online="false"');
    const t = text(html);
    expect(t).toContain('runner-1 Online');
    expect(t).toContain('runner-2 Offline');
    expect(t).toContain('2 /4 busy');
    expect(t).toContain('0 /4 busy');
    // Home's slot meter, one square per slot.
    expect(html).toContain('aria-label="2 of 4 slots in use"');
    // Home's label vocabulary.
    expect(t).toContain('Fleet · 2 runners × 4 slots');
  });

  it('headlines busy of capacity, and counts offline runners', () => {
    const f = fleet([runner('a', 'runner-1', 3, 4), runner('b', 'runner-2', 0, 4, false)]);
    expect(fleetOverviewHeadline(f).map(p => p.text).join('')).toBe('3 of 4 slots busy. 1 offline.');
    expect(fleetOverviewHeadline(fleet([runner('a', 'runner-1', 0, 5)])).map(p => p.text).join('')).toBe('Fleet idle. 5 slots free.');
    expect(fleetOverviewHeadline(fleet([runner('a', 'runner-1', 0, 2, false)])).map(p => p.text).join('')).toBe('All runners offline.');
    expect(fleetOverviewHeadline(fleet([])).map(p => p.text).join('')).toBe('No runners online.');
    expect(fleetOverviewHeadline(fleet([]), 'Team 1').map(p => p.text).join('')).toBe('No runners online for Team 1.');
  });

  it('flags a runner whose agent is waiting on you', () => {
    const html = renderToStaticMarkup(<FleetOverview fleet={fleet([runner('a', 'runner-1', 1, 2, true, true)])} />);
    expect(text(html)).toContain('1 waiting on you');
  });

  it('with no runners, says how to start one and still shows the cloud row', () => {
    const html = renderToStaticMarkup(<FleetOverview fleet={fleet([])} cloud={<li data-testid="fleet-cloud-row">cloud</li>} />);
    expect(html).toContain('data-testid="fleet-runner-empty"');
    expect(html).toContain('data-testid="fleet-cloud-row"');
    expect(html).not.toContain('Live slots on Home');
  });
});

describe('Settings → Runners page order', () => {
  it('fleet, then connections, then runner tokens', async () => {
    const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
    const fleetAt = page.indexOf('<FleetOverview');
    const connAt = page.indexOf('title="Connections"');
    const tokensAt = page.indexOf('<RunnerTokensSection');
    expect(fleetAt).toBeGreaterThan(-1);
    expect(connAt).toBeGreaterThan(fleetAt);
    expect(page.indexOf('<AgentBackendsSection')).toBeGreaterThan(connAt);
    expect(page.indexOf('<CloudflareSection')).toBeGreaterThan(connAt);
    expect(tokensAt).toBeGreaterThan(page.indexOf('<CloudflareSection'));
    // The same heartbeat-backed snapshot Home builds, not a new API.
    expect(page).toContain("import { loadFleetSnapshot } from '@/lib/home-fleet'");
  });
});
