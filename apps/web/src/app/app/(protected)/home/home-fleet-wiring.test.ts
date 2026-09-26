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

  it('on a phone the ticker comes last, never between the asks and the fleet', () => {
    const ticker = home.indexOf('<ActivityTicker');
    const wrapper = home.lastIndexOf('<div className="order-last', ticker);
    expect(wrapper).toBeGreaterThan(home.indexOf('<NeedsYouStack'));
    expect(ticker - wrapper).toBeLessThan(120);
  });

  it('operators get the fleet panel up top; members get it as a compact line after their missions', () => {
    expect(home).toContain("audience = homeAudience(await getUserTeamRole(");
    const operator = home.indexOf("audience === 'operator' && fleetData && <FleetStrip");
    const missions = home.indexOf('<HomeMissionsSummary');
    const member = home.indexOf("audience === 'member' && fleetData");
    expect(operator).toBeGreaterThan(-1);
    expect(operator).toBeLessThan(missions);
    expect(member).toBeGreaterThan(missions);
    expect(home.slice(member, member + 300)).toContain('compact');
  });

  it('renders the redesigned sections with stable test ids', () => {
    for (const id of ['home-headline', 'home-right-now']) expect(home).toContain(`data-testid="${id}"`);
    for (const c of ['<StatStrip', '<FleetStrip', '<NeedsYouStack', '<ActivityTicker', '<HomeMissionsSummary']) expect(home).toContain(c);
  });
});
