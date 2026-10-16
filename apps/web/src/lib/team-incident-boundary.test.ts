import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The incident machinery is the platform operator's. A team member or admin
 * reaches service status (lib/service-status.ts), never the incident page, its
 * API, an incident card on Home, or an incident line on Health.
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');

describe('team surfaces and the incident machinery', () => {
  it('sends team members and admins away from the incident page before reading any row', () => {
    const page = read('app/app/(protected)/incidents/[id]/page.tsx');
    const gate = page.indexOf('isPlatformOperator(user)');
    expect(gate).toBeGreaterThan(-1);
    expect(page).toMatch(/if \(!isPlatformOperator\(user\)\) redirect\('\/app\/health'\)/);
    expect(gate).toBeLessThan(page.indexOf('db.query.failureIncidents'));
  });

  it('gates the incident API sessions on the platform operator', () => {
    expect(read('app/api/health/incidents/route.ts')).toMatch(/sessionUser && !isPlatformOperator\(sessionUser\)/);
    expect(read('app/api/health/incidents/[id]/route.ts')).toMatch(/user && !isPlatformOperator\(user\)/);
  });

  it('loads incident cards onto Home only for a platform operator', () => {
    expect(read('app/app/(protected)/home/page.tsx')).toMatch(/isPlatformOperator\(user\)\) \{\s*waitingOnYou\.push\(\.\.\.await INCIDENT_NEEDS_YOU/);
  });

  it('does not load incident state into Health failure groups', () => {
    const data = read('app/app/(protected)/health/_lib/health-data.ts');
    expect(data).not.toContain('loadFailureIncidentStates');
  });

  it('keeps "Open incident" out of the Home attention card fallback', () => {
    expect(read('lib/home-attention.ts')).not.toContain('Open incident');
  });

  it('keeps the projection free of operator vocabulary and of the operator role', () => {
    const src = read('lib/service-status.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/isPlatformOperator|platform-operator|lib\/admin/);
    expect(src).not.toMatch(/'[^']*[Ii]ncident[^']*'/);
  });
});
