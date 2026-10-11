import { describe, it, expect } from 'bun:test';
import { HEALTH_NAV, HEALTH_INDEX_HREF, healthItemFor, healthNavFor } from './health-nav';

describe('healthItemFor', () => {
  it('maps each route to its item; Overview only on the index', () => {
    expect(healthItemFor('/app/health')?.id).toBe('overview');
    expect(healthItemFor('/app/health/failures')?.id).toBe('failures');
    expect(healthItemFor('/app/health/runners')?.id).toBe('runners');
    expect(healthItemFor('/app/health/usage')?.id).toBe('usage');
    expect(healthItemFor('/app/health/insights')?.id).toBe('insights');
    expect(healthItemFor('/app/health/operator')?.id).toBe('operator');
  });

  it('is null outside Health and for look-alike paths', () => {
    expect(healthItemFor('/app/settings')).toBeNull();
    expect(healthItemFor('/app/healthy')).toBeNull();
  });
});

describe('healthNavFor', () => {
  const member = { operator: false, teamAdmin: false };
  const admin = { operator: false, teamAdmin: true };
  const owner = { operator: true, teamAdmin: true };

  it('hides Operator from everyone who is not the platform owner, team admins included', () => {
    expect(healthNavFor(member).map(i => i.id)).not.toContain('operator');
    expect(healthNavFor(admin).map(i => i.id)).not.toContain('operator');
    expect(healthNavFor(owner).map(i => i.id)).toContain('operator');
  });

  it('shows a team admin Failures, Usage and Insights for their own team', () => {
    expect(healthNavFor(admin).map(i => i.id)).toEqual(['overview', 'failures', 'runners', 'estimates', 'usage', 'insights']);
  });

  it("shows a member Failures and their own Usage, but not the team's Insights", () => {
    expect(healthNavFor(member).map(i => i.id)).toEqual(['overview', 'failures', 'runners', 'estimates', 'usage']);
  });

  it('keeps registry order, Overview first', () => {
    expect(healthNavFor(owner).map(i => i.id)).toEqual(HEALTH_NAV.map(i => i.id));
    expect(HEALTH_NAV[0].href).toBe(HEALTH_INDEX_HREF);
  });
});
