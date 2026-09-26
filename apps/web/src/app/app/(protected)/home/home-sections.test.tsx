/**
 * Home's redesigned sections render their model with stable test ids and
 * tokens only. Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(''),
}));

import { buildFleetSnapshot } from '@/lib/fleet-view';
import { buildTickerEvents } from '@/lib/home-ticker';
import { StatStrip } from './StatStrip';
import { FleetStrip } from './FleetStrip';
import { NeedsYouStack } from './NeedsYouStack';
import { ActivityTicker } from './ActivityTicker';
import { splitOption } from './NeedsYouCards';

const NOW = Date.UTC(2026, 0, 10, 14, 12);
const min = (m: number) => new Date(NOW - m * 60_000);

const fleet = buildFleetSnapshot(
  [{ id: 'h1', accountId: 'a', localUiUrl: 'http://atlas.local:8766', maxConcurrentWorkers: 2, lastHeartbeatAt: new Date(NOW) }],
  [
    { id: 'w1', accountId: 'a', runner: 'http://atlas.local:8766', status: 'running', startedAt: min(5), progress: 40, task: { id: 't1', title: 'feat(api): currency on invoices', roleSlug: 'builder', missionId: 'm1' } },
    { id: 'w2', accountId: 'a', runner: 'http://atlas.local:8766', status: 'waiting_input', startedAt: min(3), waitingFor: { prompt: 'Per line or total?' }, task: { id: 't2', title: 'feat(checkout): pay', roleSlug: 'builder', missionId: 'm1' } },
  ],
  { now: NOW, roles: new Map([['builder', { name: 'Builder', color: '#0C72CB' }]]) },
);

describe('StatStrip', () => {
  const html = renderToStaticMarkup(
    <StatStrip live={2} capacity={8} runners={1} needsYou={1} needsYouDetail="1 question" mergedToday={3} mergedDetail="#1 #2 #3" prsInCi={[]} selfHealed={1} />,
  );
  it('shows the four numbers, and self-healed once CI is quiet', () => {
    expect(html).toContain('data-testid="home-stat-strip"');
    expect(html).toContain('data-testid="stat-agents-live"');
    expect(html).toContain('data-testid="slot-meter"');
    expect(html).toContain('data-testid="stat-self-healed"');
    expect(html).not.toContain('data-testid="stat-prs-in-ci"');
  });
});

describe('FleetStrip', () => {
  const html = renderToStaticMarkup(<FleetStrip fleet={fleet} roles={[{ slug: 'builder', name: 'Builder', color: '#0C72CB' }]} now={NOW} timeZone="UTC" />);
  it('one fleet-slot row per slot, with the parked worker flagged', () => {
    expect(html).toContain('data-testid="home-fleet"');
    expect(html.match(/data-testid="fleet-slot"/g)?.length).toBe(2);
    expect(html).toContain('data-status="waiting_input"');
    expect(html).toContain('Waiting on you');
  });
  it('draws the timeline through the shared SlotLanes chart', () => {
    expect(html).toContain('data-testid="fleet-lanes"');
    expect(html.match(/data-testid="slot-lane-row"/g)?.length).toBe(2);
  });
  it('links slots into the mission, never to a bare task page', () => {
    expect(html).not.toContain('href="/app/tasks/');
  });
});

describe('NeedsYouStack', () => {
  const html = renderToStaticMarkup(
    <NeedsYouStack
      count={2}
      questions={[{ workerId: 'w2', taskId: 't2', href: '/app/missions/m1?from=home&task=t2', label: 'checkout', runnerName: 'atlas', askedAt: null, prompt: 'Per line or total?', options: ['Per line — match Stripe', 'Total only'] }]}
      held={[{ id: 'm9', title: 'Spec first', href: '/app/missions/m9', ready: 1, roles: ['writer'], done: 0, total: 1, heldFor: '1d' }]}
      shipped={[]}
    />,
  );
  it('stacks one card per ask with one-tap answers and Arm', () => {
    expect(html).toContain('data-testid="home-waiting-on-you"');
    expect(html.match(/data-testid="needs-you-card"/g)?.length).toBe(2);
    expect(html.match(/data-testid="needs-you-answer"/g)?.length).toBe(2);
    expect(html).toContain('data-testid="mission-arm-button"');
    expect(html).toContain('>2</span>');
  });
  it('splits an option into its answer and its reason', () => {
    expect(splitOption('Per line — match Stripe')).toEqual({ main: 'Per line', sub: 'match Stripe' });
    expect(splitOption('Total only')).toEqual({ main: 'Total only', sub: null });
  });
});

describe('ActivityTicker', () => {
  it('one glyph row per event under home-activity', () => {
    const events = buildTickerEvents(
      [{ id: 'w1', status: 'completed', startedAt: min(9), completedAt: min(4), mergedAt: min(2), prNumber: 412, task: { id: 't1', title: 'feat(money): x', missionId: 'm1' } }],
      [],
    );
    const html = renderToStaticMarkup(<ActivityTicker events={events} timeZone="UTC" />);
    expect(html).toContain('data-testid="home-activity"');
    expect(html.match(/data-testid="ticker-row"/g)?.length).toBe(3);
    expect(html).not.toContain('via ');
  });
});
