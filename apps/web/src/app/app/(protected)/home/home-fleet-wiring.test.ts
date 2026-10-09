/**
 * Home's fleet wiring, read from source: the live-worker read is uncapped (a
 * `limit: 10` hid the 11th agent from the page), and the fleet loader keeps
 * every live worker inside its row cap by reading newest-started first.
 */
import { describe, expect, it } from 'bun:test';

const home = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
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

  it('the decisions come first, then Agents / Moving / Landed in grid areas, the ticker last', () => {
    const stack = home.indexOf('<NeedsYouStack');
    const body = home.indexOf('data-testid="home-body"');
    const ticker = home.indexOf('<ActivityTicker');
    expect(stack).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(stack);
    expect(ticker).toBeGreaterThan(body);
    expect(home).toContain("min-[900px]:[grid-template-areas:'moving_agents'_'moving_landed']");
    expect(home).toContain("[grid-template-areas:'agents'_'moving'_'landed']");
  });

  // Desktop at 1280: In flight sat full-width inside the decisions grid and
  // pinned every auto-fit track open, so one ask rendered half width.
  it('the decisions grid holds only cards; In flight lives in the Moving column', () => {
    const stack = home.slice(home.indexOf('<NeedsYouStack'), home.indexOf('</NeedsYouStack>'));
    expect(stack).not.toContain('[grid-column:1/-1]');
    expect(stack).not.toContain('waiting-in-flight');
    const moving = home.indexOf("gridArea: 'moving'");
    const inFlight = home.indexOf('data-testid="waiting-in-flight"');
    expect(moving).toBeGreaterThan(-1);
    expect(inFlight).toBeGreaterThan(moving);
    expect(inFlight).toBeLessThan(home.indexOf('<LandedThisWeek missions={landedWeek} timeZone={teamTz} />'));
  });

  it('an all-clear Home with nothing moving puts Agents beside Landed, never beside an empty column', () => {
    expect(home).toContain("min-[900px]:[grid-template-areas:'agents_landed']");
    expect(home).toMatch(/const movingEmpty =/);
  });

  it('the header is the headline and one plain sub-line', () => {
    const header = home.slice(home.indexOf('data-testid="home-headline"'), home.indexOf('</header>'));
    expect(header).toContain('data-testid="home-subline"');
    expect(header).not.toContain('arcHeadline');
  });

  it('the fleet lanes and role legend are off Home; Agents replaces them', () => {
    expect(home).toContain('<AgentsPanel');
    expect(home).not.toContain('<FleetStrip');
    expect(home).not.toContain('<StatStrip');
    expect(home).toContain('getUserTeamRole(user.id, activeTeamId)');
  });

  it('renders the redesigned sections with stable test ids', () => {
    for (const id of ['home-headline', 'home-right-now', 'home-body']) expect(home).toContain(`data-testid="${id}"`);
    for (const c of ['<AgentsPanel', '<NeedsYouStack', '<ActivityTicker', '<LandedThisWeek', '<DeliveryMilestones']) expect(home).toContain(c);
  });
});
