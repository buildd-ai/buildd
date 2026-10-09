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
import { CanvasContext } from '@/components/chat/canvas-context';
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
    { id: 'w1', accountId: 'a', runner: 'http://atlas.local:8766', status: 'running', startedAt: min(5), phase: 'Changes', task: { id: 't1', title: 'feat(api): currency on invoices', roleSlug: 'builder', missionId: 'm1' } },
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
    expect(html).toContain('data-testid="stat-slots-online"');
    expect(html).toContain('data-testid="stat-self-healed"');
    expect(html).not.toContain('data-testid="stat-prs-in-ci"');
  });

  const quiet = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <StatStrip live={0} capacity={8} runners={1} needsYou={0} needsYouDetail={null} mergedToday={3} mergedDetail={null} prsInCi={[]} selfHealed={0} {...extra} />,
  );

  it('does not lead with "Self-healed 0" when nothing failed', () => {
    const html = quiet();
    expect(html).not.toContain('data-testid="stat-self-healed"');
    expect(html).not.toMatch(/self-healed/i);
  });

  it('shows the screens reviewed in that slot when there was a visual review', () => {
    const html = quiet({ screensReviewed: { shots: 6, ok: 6, issues: 0, unsure: 0 } });
    expect(html).toContain('data-testid="stat-screens-reviewed"');
    expect(html.replace(/<[^>]+>/g, ' ')).toMatch(/Screens reviewed\s+6\s+all ok/);
  });
});

describe('NeedsYouStack shipped card', () => {
  const shipped = (over: Record<string, unknown> = {}) => ({
    id: 'm1', title: 'Example mission', href: '/app/missions/m1', completedAt: '2026-01-10T14:00:00.000Z',
    prs: 11, fixes: 0, durationMs: 37 * 60_000, criteria: null, ...over,
  });
  const text = (over: Record<string, unknown> = {}) => renderToStaticMarkup(
    <NeedsYouStack count={0} questions={[]} held={[]} shipped={[shipped(over)]} timeZone="UTC" />,
  ).replace(/<[^>]+>/g, ' ');

  it('drops "0 auto-fixes" and shows the visual review instead', () => {
    const t = text({ screens: { shots: 6, ok: 6, issues: 0, unsure: 0 } });
    expect(t).not.toMatch(/auto-fix/);
    expect(t).toMatch(/6\/6\s+screens ok/);
  });

  it('the summary link lands on the mission page\'s What shipped header', () => {
    const html = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[shipped({ href: '/app/missions/m1?from=home' })]} timeZone="UTC" />,
    );
    expect(html).toContain('href="/app/missions/m1?from=home#what-shipped"');
  });

  it('keeps auto-fixes when there were some', () => {
    expect(text({ fixes: 2 })).toMatch(/2\s+auto-fixes/);
  });

  it('a mission open for weeks: agent work and filed-to-shipped, never one wall-clock figure', () => {
    const t = text({ durationMs: 35 * 86_400_000, activeMs: 40 * 60_000 });
    expect(t).toMatch(/40m\s+agent work/);
    expect(t).toMatch(/35d\s+to ship/);
    // A bare "open" under the big number read as time spent working.
    expect(t).not.toMatch(/\sopen\s/);
    expect(t).not.toMatch(/wall clock/);
  });

  it('one figure when the work filled the window', () => {
    const t = text({ activeMs: 35 * 60_000 });
    expect(t).toMatch(/35m\s+agent work/);
    expect(t).not.toMatch(/to ship/);
  });
});

describe('FleetStrip', () => {
  const html = renderToStaticMarkup(<FleetStrip fleet={fleet} roles={[{ slug: 'builder', name: 'Builder', color: '#0C72CB' }]} now={NOW} timeZone="UTC" />);
  it('one fleet-slot row per slot, with the parked worker flagged', () => {
    expect(html).toContain('data-testid="home-fleet"');
    expect(html.match(/data-testid="fleet-slot"/g)?.length).toBe(2);
    expect(html).toContain('data-status="waiting_input"');
    expect(html).toContain('Needs input');
  });
  it('draws the timeline through the shared SlotLanes chart', () => {
    expect(html).toContain('data-testid="fleet-lanes"');
    expect(html.match(/data-testid="slot-lane-row"/g)?.length).toBe(2);
  });
  it('links slots into the mission, never to a bare task page', () => {
    expect(html).not.toContain('href="/app/tasks/');
  });
  it('says runners, not fleet: no ops jargon on Home', () => {
    const compact = renderToStaticMarkup(<FleetStrip fleet={fleet} roles={[]} now={NOW} timeZone="UTC" compact />);
    for (const h of [html, compact]) expect(h).not.toMatch(/>\s*Fleet\b/i);
    expect(compact).toContain('Runners');
  });
});

describe('FleetStrip — your sessions lane', () => {
  const host = { id: 'h1', accountId: 'a', localUiUrl: 'http://atlas.local:8766', maxConcurrentWorkers: 2, lastHeartbeatAt: new Date(NOW) };
  const claim = (id: string, startedAt: Date | null = min(6)) => ({
    id: `w-${id}`, accountId: 'a', runner: 'mcp', status: 'running', startedAt, updatedAt: min(1),
    task: { id: `t-${id}`, title: `feat(${id}): local work`, roleSlug: 'builder', missionId: null },
  });
  const f = buildFleetSnapshot([host], [claim('mine'), claim('nostart', null)], { now: NOW, sessionsOnline: 4 });
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);
  const t = html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('session claims are their own lane after the runners: one working row each, never offline or idle', () => {
    expect(html.match(/data-testid="fleet-runner"/g)?.length).toBe(2);
    expect(html).toContain('data-interactive="true"');
    const lane = html.slice(html.indexOf('data-interactive="true"'));
    expect(lane).toContain('Your sessions');
    expect(lane.match(/data-busy="true"/g)?.length).toBe(2);
    expect(lane).not.toContain('offline');
    expect(lane).not.toContain('idle');
    expect(t).toContain('2 working');
    expect(t).toContain('4 online');
  });
  it('the runner count and the label stay about runners', () => {
    expect(t).toContain('Runners · 1 runner × 2 slots');
    expect(t).not.toContain('2 runners');
  });
  it('the timeline draws the sessions lane too', () => {
    expect(html.match(/data-testid="slot-lane-row"/g)?.length).toBe(3);
  });
  it('no live session claim, no lane', () => {
    const quiet = buildFleetSnapshot([host], [{ ...claim('old'), status: 'completed', completedAt: min(2) }], { now: NOW, sessionsOnline: 4 });
    const h = renderToStaticMarkup(<FleetStrip fleet={quiet} roles={[]} now={NOW} timeZone="UTC" />);
    expect(h).not.toContain('data-interactive="true"');
    expect(h).not.toContain('Your sessions');
  });
  it('a session claim with no runner online still shows, instead of the no-runners hint', () => {
    const solo = buildFleetSnapshot([], [claim('mine')], { now: NOW });
    const h = renderToStaticMarkup(<FleetStrip fleet={solo} roles={[]} now={NOW} timeZone="UTC" />);
    expect(h).toContain('Your sessions');
    expect(h).not.toContain('No runners online');
  });
});

describe('FleetStrip — a cloud dispatcher is one elastic group', () => {
  const onceUrl = (t: string) => `headless://container/once/${t}`;
  const cloudHb = (t: string) => ({
    id: `hb-${t}`, accountId: 'a', localUiUrl: onceUrl(t), maxConcurrentWorkers: 1, lastHeartbeatAt: new Date(NOW), activeWorkerCount: 1,
    environment: { labels: { hostname: 'container', os: 'linux', arch: 'x64' }, fleet: { executor: 'cloud', ephemeral: true, concurrency: 1, group: 'my-dispatcher' } },
  });
  const run = (t: string, status = 'running') => ({
    id: `w-${t}`, accountId: 'a', runner: onceUrl(t), localUiUrl: onceUrl(t), status, startedAt: min(4), completedAt: status === 'running' ? null : min(1),
    task: { id: `t-${t}`, title: `feat(${t}): cloud work`, roleSlug: 'builder', missionId: 'm1' },
  });
  const f = buildFleetSnapshot(
    [{ id: 'h1', accountId: 'a', localUiUrl: 'http://atlas.local:8766', maxConcurrentWorkers: 2, lastHeartbeatAt: new Date(NOW) }, cloudHb('a'), cloudHb('b'), cloudHb('c')],
    [run('a'), run('b'), run('c', 'completed')],
    { now: NOW },
  );
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);
  const t = html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('two runner rows, not one per container: the host and the group', () => {
    expect(html.match(/data-testid="fleet-runner"/g)?.length).toBe(2);
    expect(html.match(/data-elastic="true"/g)?.length).toBe(1);
  });
  it('the group reads Cloudflare · elastic · N running, with one row per live run and no idle slots', () => {
    expect(t).toContain('my-dispatcher');
    expect(t).toContain('Cloudflare · elastic');
    expect(html).toContain('data-testid="fleet-elastic-running"');
    expect(t).toContain('2 running');
    // Group: its 2 live runs, both busy. The finished run is not a row. The
    // host's 2 quiet slots fold into its own "2 idle slots" row as before.
    expect(html.match(/data-testid="fleet-slot"/g)?.length).toBe(2);
    expect(html.match(/data-busy="true"/g)?.length).toBe(2);
    expect(html.match(/data-testid="fleet-idle-slots"/g)?.length).toBe(1);
  });
  it('the section label counts the group apart from the machines', () => {
    expect(t).toContain('Runners · 1 runner × 2 slots + 1 elastic group');
  });
});

describe('FleetStrip — a one-run elastic group fits its single row', () => {
  const url = 'headless://container/once/solo';
  const f = buildFleetSnapshot(
    [{
      id: 'hb-solo', accountId: 'a', localUiUrl: url, maxConcurrentWorkers: 1, lastHeartbeatAt: new Date(NOW), activeWorkerCount: 1,
      environment: { labels: { hostname: 'container', os: 'linux', arch: 'x64' }, fleet: { executor: 'cloud', ephemeral: true, concurrency: 1, group: 'agent-runtime-spike' } },
    }],
    [{ id: 'w-solo', accountId: 'a', runner: url, localUiUrl: url, status: 'running', startedAt: min(2), task: { id: 't-solo', title: 'sizing memory overhead' } }],
    { now: NOW },
  );
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);
  const cell = html.slice(html.indexOf('data-elastic="true"'), html.indexOf('data-testid="fleet-slot"'));

  it('like a one-row machine, desktop shows the name alone; the executor moves to its title, never "· 1 running" squeezed beside it', () => {
    expect(cell).toContain('title="agent-runtime-spike · Cloudflare · elastic"');
    expect(cell).not.toContain('· 1 running');
    expect(cell).toMatch(/class="max-w-full truncate[^"]*md:hidden">Cloudflare · elastic</);
  });
  it('the single busy row already is the run, so the count hides on desktop (still there on mobile)', () => {
    expect(cell).toMatch(/data-testid="fleet-elastic-running" class="[^"]*md:hidden[^"]*">1 running/);
  });
});

describe('FleetStrip — Steer', () => {
  it('a running slot offers Steer when the chat canvas is available; a waiting-on-you slot does not (the question hero owns that)', () => {
    const html = renderToStaticMarkup(
      <CanvasContext.Provider value={{ open: () => {}, openSteer: () => {}, close: () => {}, isOpen: false }}>
        <FleetStrip fleet={fleet} roles={[{ slug: 'builder', name: 'Builder', color: '#0C72CB' }]} now={NOW} timeZone="UTC" />
      </CanvasContext.Provider>,
    );
    expect(html.match(/data-testid="steer-trigger"/g)?.length).toBe(1);
  });

  it('nothing to steer without the chat canvas in context', () => {
    const html = renderToStaticMarkup(<FleetStrip fleet={fleet} roles={[{ slug: 'builder', name: 'Builder', color: '#0C72CB' }]} now={NOW} timeZone="UTC" />);
    expect(html).not.toContain('data-testid="steer-trigger"');
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
    { id: 'w1', accountId: 'a', runner: 'http://q.local:1', status: 'running', startedAt: min(30), phase: 'Pushed', task: { id: 't1', title: 'feat(onboarding): checklist survives reload', roleSlug: 'builder', missionId: 'm1' } },
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

  // Regression (UX review, initiatives story): a slot running for two days read
  // "55% · 2856m". Elapsed time uses the same compact durations as the lists.
  it('a long-running slot shows hours or days, not thousands of minutes', () => {
    const longFleet = buildFleetSnapshot([hb], [
      { id: 'w2', accountId: 'a', runner: 'http://q.local:1', status: 'running', startedAt: min(2856), phase: 'Pushed', task: { id: 't2', title: 'docs: runnable examples', roleSlug: 'builder', missionId: 'm1' } },
    ], { now: NOW });
    const html = renderToStaticMarkup(<FleetStrip fleet={longFleet} roles={[]} now={NOW} timeZone="UTC" />);
    expect(html).not.toContain('2856m');
    expect(html).toContain('Pushed · 2d');
    expect(html).not.toContain('>55%');
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
      questions={[{ workerId: 'w2', taskId: 't2', href: '/app/missions/m1?from=home&task=t2', label: 'checkout', runnerName: 'atlas', askedAt: null, question: { headline: 'Per line or total?', body: null, noteId: null, context: 'Rounding each line can differ from rounding the total.', options: [{ label: 'Per line — match Stripe', recommended: false }, { label: 'Total only', recommended: false }] } }]}
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
  it('shows the question context, not just the question', () => {
    expect(html).toContain('data-testid="needs-you-context"');
    expect(html).toContain('Rounding each line can differ');
  });
  // Regression: page.tsx always passes `{cond && <…/>}` children, so with
  // nothing waiting `children` was `[false, false]` — truthy. The headline
  // already says all clear, so the section steps aside instead of heading an
  // empty column.
  it('renders nothing when every child renders nothing', () => {
    const empty = renderToStaticMarkup(
      <NeedsYouStack count={0} questions={[]} held={[]} shipped={[]}>
        {false}
        {null}
      </NeedsYouStack>,
    );
    expect(empty).toBe('');
  });
  it('renders the queue cards when the action queue has asks', () => {
    const withQueue = renderToStaticMarkup(
      <NeedsYouStack count={1} questions={[]} held={[]} shipped={[]}>
        <article data-testid="action-card" />
        {false}
      </NeedsYouStack>,
    );
    expect(withQueue).toContain('data-testid="action-card"');
    expect(withQueue).not.toContain('Nothing needs input');
  });
  // Regression (desktop at 1280): a full-row child inside the auto-fit grid
  // kept every track alive, so one card sat at half width beside dead space.
  it('keeps full-row content out of the card grid', () => {
    const html = renderToStaticMarkup(
      <NeedsYouStack count={1} questions={[]} held={[]} shipped={[]} lead={<div data-testid="lead-row" />} foot={<p data-testid="foot-row" />}>
        <article data-testid="action-card" />
      </NeedsYouStack>,
    );
    const grid = html.slice(html.indexOf('data-testid="needs-you-cards"'));
    expect(html.indexOf('data-testid="lead-row"')).toBeLessThan(html.indexOf('data-testid="needs-you-cards"'));
    expect(grid).toContain('data-testid="action-card"');
    // The grid closes right after the card; the foot follows outside it.
    expect(grid).toMatch(/data-testid="action-card"><\/article><\/div><p data-testid="foot-row"/);
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
    { id: 'y', accountId: 'a', runner: 'http://cedar.local:1', status: 'running', startedAt: min(15), phase: 'Started', task: { id: 'ty', title: 'feat(invoices): render in currency', missionId: 'm1' } },
  ], { now: NOW });
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);

  // Rows are in slot order (a running task keeps its row when the slot above it
  // frees up — demo capture, home fleet live take), and the dots follow them.
  it('rows stay in slot order and the capacity dots follow the row order', () => {
    const rows = [...html.matchAll(/data-testid="fleet-slot" data-busy="(true|false)"/g)].map(m => m[1]);
    expect(rows).toEqual(['false', 'true']);
    const meter = html.match(/<span class="mt-0.5 flex[^"]*" aria-label="[^"]*">(.*?)<\/span>/)?.[1] ?? '';
    const dots = [...meter.matchAll(/<i [^>]*class="([^"]*)"/g)].map(m => m[1].includes('bg-accent') ? 'busy' : 'idle');
    expect(dots).toEqual(['idle', 'busy']);
  });

  it('an idle row keeps its time: the age sits in its own non-shrinking column, outside the truncated text', () => {
    const at = html.match(/<span[^>]*data-testid="fleet-slot-last-at"[^>]*>/)?.[0] ?? '';
    expect(at).toContain('shrink-0');
    // The truncating span closes before the time begins.
    expect(html).toMatch(/<span class="[^"]*truncate[^"]*">idle(?:(?!<\/span><span[^>]*fleet-slot-last-at).)*<\/span>(?:<[^>]+>)*?<span[^>]*data-testid="fleet-slot-last-at"/);
  });
});

describe('FleetStrip — a just-claimed slot', () => {
  const hb = { id: 'h1', accountId: 'a', localUiUrl: 'http://dune.local:1', maxConcurrentWorkers: 2, lastHeartbeatAt: new Date(NOW) };
  const f = buildFleetSnapshot([hb], [
    { id: 'c', accountId: 'a', runner: 'http://dune.local:1', status: 'running', startedAt: new Date(NOW - 10_000), task: { id: 'tc', title: 'feat(checkout): Stripe in currency', missionId: 'm1' } },
    { id: 'd', accountId: 'a', runner: 'http://dune.local:1', status: 'running', startedAt: min(6), task: { id: 'td', title: 'feat(settings): currency picker', missionId: 'm1' } },
  ], { now: NOW });
  const html = renderToStaticMarkup(<FleetStrip fleet={f} roles={[]} now={NOW} timeZone="UTC" />);
  const slots = html.split('data-testid="fleet-slot"').slice(1);

  it('says "claimed", not "— · 0m", and draws no empty progress track', () => {
    const claimed = slots.find(s => s.includes('checkout')) ?? '';
    expect(claimed).toContain('data-testid="fleet-slot-claimed"');
    expect(claimed).not.toContain('—');
    expect(claimed).not.toContain('max-w-[150px]');
  });

  it('with no progress reported, shows only the elapsed time', () => {
    const running = slots.find(s => s.includes('currency picker')) ?? '';
    expect(running).toContain('>6m<');
    expect(running).not.toContain('—');
  });
});

describe('NeedsYouStack — nothing needs you, but work is in flight', () => {
  // In flight is the platform's next move, not yours: it lives in the Moving
  // column now, so an all-clear stack has nothing to head.
  it('renders nothing when only the foot is empty and nothing needs you', () => {
    const html = renderToStaticMarkup(<NeedsYouStack count={0} questions={[]} held={[]} shipped={[]} />);
    expect(html).toBe('');
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
