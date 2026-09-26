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

describe('FleetStrip on a real-shaped fleet (1 runner x 10 slots)', () => {
  const hb = { id: 'h1', accountId: 'a', localUiUrl: 'http://q.local:1', maxConcurrentWorkers: 10, lastHeartbeatAt: new Date(NOW),
    environment: { labels: { hostname: 'quill-studio-workstation', machine: 'Mac mini' } } };
  const done = (id: string, ago: number, title: string) => ({
    id, accountId: 'a', runner: 'http://q.local:1', status: 'completed', startedAt: min(ago + 2), completedAt: min(ago), prNumber: 900,
    task: { id: `t-${id}`, title, roleSlug: 'builder', missionId: 'm1' },
  });
  const idleFleet = buildFleetSnapshot([hb], [done('d1', 25, 'fix(pr): keep the PR body in sync after a force-push')], { now: NOW });
  const busyFleet = buildFleetSnapshot([hb], [
    done('d1', 25, 'fix(pr): keep the PR body in sync after a force-push'),
    { id: 'w1', accountId: 'a', runner: 'http://q.local:1', status: 'running', startedAt: min(30), progress: 55, task: { id: 't1', title: 'feat(onboarding): checklist survives reload', roleSlug: 'builder', missionId: 'm1' } },
  ], { now: NOW });

  it('a fully idle fleet is one summary line naming the last run, not ten idle rows', () => {
    const html = renderToStaticMarkup(<FleetStrip fleet={idleFleet} roles={[]} now={NOW} timeZone="UTC" />);
    expect(html).toContain('data-testid="fleet-summary"');
    expect(html).toContain('all 10 slots idle');
    expect(html).toContain('keep PR body');
    expect(html).not.toContain('last pr');
    // Collapsed: the table is behind the summary, and never ten rows of "idle".
    expect((html.match(/data-testid="fleet-slot"/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('with work running, the busy slot gets a row and the quiet ones fold into a count', () => {
    const html = renderToStaticMarkup(<FleetStrip fleet={busyFleet} roles={[]} now={NOW} timeZone="UTC" />);
    expect(html).not.toContain('data-testid="fleet-summary"');
    expect(html).toContain('data-busy="true"');
    expect(html).toContain('data-testid="fleet-idle-slots"');
    expect(html).toContain('8 idle slots');
    // Chart rows line up with the table: running + recent + folded row.
    expect(html.match(/data-testid="slot-lane-row"/g)?.length).toBe(html.match(/data-testid="fleet-slot"|data-testid="fleet-idle-slots"/g)?.length);
  });

  it('the runner name is never cut without its full form in a title', () => {
    const html = renderToStaticMarkup(<FleetStrip fleet={busyFleet} roles={[]} now={NOW} timeZone="UTC" />);
    expect(html).toContain('title="quill-studio-workstation"');
  });

  it('compact mode (a member Home) folds even a busy fleet into the summary line', () => {
    const html = renderToStaticMarkup(<FleetStrip fleet={busyFleet} roles={[]} now={NOW} timeZone="UTC" compact />);
    expect(html).toContain('data-testid="fleet-summary"');
    expect(html).toContain('1 of 10 slots busy');
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
  // Regression: page.tsx always passes `{cond && <…/>}` children, so with
  // nothing waiting `children` was `[false, false]` — truthy — and the heading
  // rendered over an empty column with no empty state.
  it('shows the empty state when every child renders nothing', () => {
    const empty = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[]}>
        {false}
        {null}
      </NeedsYouStack>,
    );
    expect(empty).toContain('Nothing waiting on you');
    expect(empty).not.toContain('data-testid="needs-you-count"');
  });
  it('does not show the empty state when the action queue renders', () => {
    const withQueue = renderToStaticMarkup(
      <NeedsYouStack count={1} questions={[]} held={[]} shipped={[]}>
        <div data-testid="home-action-queue" />
        {false}
      </NeedsYouStack>,
    );
    expect(withQueue).not.toContain('Nothing waiting on you');
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

describe('FleetStrip — demo polish regressions', () => {
  const hb = { id: 'h1', accountId: 'a', localUiUrl: 'http://cedar.local:1', maxConcurrentWorkers: 2, lastHeartbeatAt: new Date(NOW) };
  // X ran first (slot 0) and finished; Y overlapped it (slot 1) and is still running.
  const f = buildFleetSnapshot([hb], [
    { id: 'x', accountId: 'a', runner: 'http://cedar.local:1', status: 'completed', startedAt: min(20), completedAt: min(4), task: { id: 'tx', title: 'feat(fx): rates service', missionId: 'm1' } },
    { id: 'y', accountId: 'a', runner: 'http://cedar.local:1', status: 'running', startedAt: min(15), progress: 20, task: { id: 'ty', title: 'feat(invoices): render in currency', missionId: 'm1' } },
  ], { now: NOW });
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);

  it('the capacity dots follow the row order (busy slot listed first → filled dot first)', () => {
    const rows = [...html.matchAll(/data-testid="fleet-slot" data-busy="(true|false)"/g)].map(m => m[1]);
    expect(rows).toEqual(['true', 'false']);
    const meter = html.match(/<span class="mt-0.5 flex[^"]*" aria-label="[^"]*">(.*?)<\/span>/)?.[1] ?? '';
    const dots = [...meter.matchAll(/<i [^>]*class="([^"]*)"/g)].map(m => m[1].includes('bg-accent') ? 'busy' : 'idle');
    expect(dots).toEqual(['busy', 'idle']);
  });

  it('an idle row keeps its time: the age sits in its own non-shrinking column, outside the truncated text', () => {
    const at = html.match(/<span[^>]*data-testid="fleet-slot-last-at"[^>]*>/)?.[0] ?? '';
    expect(at).toContain('shrink-0');
    // The truncating span closes before the time begins.
    expect(html).toMatch(/<span class="[^"]*truncate[^"]*">idle(?:(?!<\/span><span[^>]*fleet-slot-last-at).)*<\/span>(?:<[^>]+>)*?<span[^>]*data-testid="fleet-slot-last-at"/);
  });
});

describe('NeedsYouStack — nothing needs you, but work is in flight', () => {
  // Regression: the stack's only child was the action queue holding IN FLIGHT
  // cards, so `hasChildren` suppressed the empty state and the NEEDS YOU
  // heading sat over nothing but "IN FLIGHT 1".
  it('says "Nothing waiting on you" above the in-flight cards when the count is 0', () => {
    const html = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[]}>
        <div data-testid="home-action-queue"><div data-testid="waiting-in-flight">In flight 1</div></div>
      </NeedsYouStack>,
    );
    expect(html).toContain('Nothing waiting on you');
    expect(html.indexOf('Nothing waiting on you')).toBeLessThan(html.indexOf('waiting-in-flight'));
  });
});

describe('ActivityTicker — a quiet gap reads as a gap', () => {
  it('draws a divider before an event far older than the one above it', () => {
    const events = [
      { id: 'e1', at: NOW - 60_000, kind: 'claim' as const, label: 'money', detail: '→ atlas', right: 'claimed', href: null, count: 1 },
      { id: 'e2', at: NOW - 2 * 60_000, kind: 'claim' as const, label: 'db', detail: '→ atlas', right: 'claimed', href: null, count: 1 },
      { id: 'e3', at: NOW - 6 * 3_600_000, kind: 'claim' as const, label: 'plan', detail: '→ dune', right: 'claimed', href: null, count: 1 },
    ];
    const html = renderToStaticMarkup(<ActivityTicker events={events} timeZone="UTC" />);
    expect(html.match(/data-testid="ticker-gap"/g)?.length).toBe(1);
    expect(html.indexOf('data-testid="ticker-gap"')).toBeGreaterThan(html.indexOf('>db<'));
    expect(html).toContain('6h earlier');
  });
});
