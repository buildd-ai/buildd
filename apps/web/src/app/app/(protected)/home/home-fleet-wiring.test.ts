/**
 * Home's fleet wiring, read from source: the live-worker read is uncapped (a
 * `limit: 10` hid the 11th agent from the page), and the fleet loader keeps
 * every live worker inside its row cap by reading newest-started first.
 */
import { describe, expect, it } from 'bun:test';

const home = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const body = await Bun.file(new URL('./HomeBody.tsx', import.meta.url)).text();
const loader = await Bun.file(new URL('../../../../lib/home-fleet.ts', import.meta.url)).text();

describe('Home live workers', () => {
  it('the active-workers query carries no limit', () => {
    const at = home.indexOf('const activeWorkers = await db.query.workers.findMany({');
    expect(at).toBeGreaterThan(-1);
    const block = home.slice(at, home.indexOf('with: {', at));
    expect(block).not.toMatch(/limit:\s*\d+/);
  });

  it('the fleet loader reads live workers unconditionally and newest first', () => {
    expect(loader).toContain('inArray(workers.status, [...LIVE_WORKER_STATUSES])');
    expect(loader).toContain('.orderBy(desc(workers.startedAt))');
  });

  // Owner acceptance (Oct 9): Home keeps decisions, Agents, Moving toward
  // delivery and Landed this week. The ticker, the release queue and the In
  // flight counters live on Activity and Health.
  it('Home is one HomeBody: decisions first, then Agents / Moving / Landed in grid areas', () => {
    expect(home.match(/<HomeBody\b/g)).toHaveLength(1);
    expect(body).toContain('data-testid="home-waiting-on-you"');
    expect(body.indexOf('data-testid="home-waiting-on-you"')).toBeLessThan(body.indexOf('data-testid="home-body"'));
    expect(body).toContain("min-[900px]:[grid-template-areas:'moving_agents'_'moving_landed']");
    expect(body).toContain("[grid-template-areas:'agents'_'moving'_'landed']");
    expect(body).toContain("min-[900px]:[grid-template-areas:'agents_landed']");
  });

  it('diagnostics are off Home', () => {
    for (const gone of ['<ActivityTicker', '<ReleaseWidget', 'waiting-in-flight', 'Agent Reviewing', 'Review Queued', 'resolveGatedReleaseState']) {
      expect(home).not.toContain(gone);
    }
  });

  it('the header is the headline and one plain sub-line, from the list itself', () => {
    const header = body.slice(body.indexOf('<header'), body.indexOf('</header>'));
    expect(header).toContain('data-testid="home-headline"');
    expect(header).toContain('data-testid="home-subline"');
    expect(header).toContain('copy.headline');
    expect(header).not.toContain('arcHeadline');
  });

  it('the fleet lanes and role legend are off Home; Agents replaces them', () => {
    expect(home).toContain('<AgentsPanel');
    expect(home).not.toContain('<FleetStrip');
    expect(home).not.toContain('<StatStrip');
    expect(home).toContain('getUserTeamRole(user.id, activeTeamId)');
  });

  it('renders the redesigned sections with stable test ids', () => {
    for (const id of ['home-headline', 'home-body', 'home-waiting-on-you', 'needs-you-count']) expect(body).toContain(`data-testid="${id}"`);
    for (const c of ['<AgentsPanel', '<LandedThisWeek']) expect(home).toContain(c);
    expect(body).toContain('<DeliveryMilestones');
  });
});
