import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The incident machinery is not part of the open product's surfaces. A team
 * member, a team admin and the platform operator all reach service status
 * (lib/service-status.ts); there is no incident page, no incident API, no
 * incident card on Home and no incident line on Health. Operator tooling
 * reads root causes through the platform-owner API
 * (app/api/admin/root-causes/route.ts).
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');
const exists = (rel: string) => existsSync(resolve(import.meta.dir, '..', rel));

describe('team surfaces and the incident machinery', () => {
  it('ships no incident page and no incident API', () => {
    expect(exists('app/app/(protected)/incidents')).toBe(false);
    expect(exists('app/api/health/incidents')).toBe(false);
    expect(exists('components/incidents')).toBe(false);
  });

  it('keeps the root-cause record and its platform-owner route', () => {
    expect(exists('lib/root-cause-record.ts')).toBe(true);
    expect(exists('app/api/admin/root-causes/route.ts')).toBe(true);
  });

  it('pages nobody from the open product', () => {
    expect(exists('lib/failure-incident-escalation.ts')).toBe(false);
    expect(read('lib/failure-incident-actions.ts')).toMatch(/export function defaultIncidentSender\(\): IncidentAlertSender \{\s*return async \(\) => false;\s*\}/);
  });

  it('offers no incident MCP actions', () => {
    const tools = readFileSync(resolve(import.meta.dir, '../../../../packages/core/mcp-tools.ts'), 'utf8');
    expect(tools).not.toMatch(/'(list|update)_incidents?'/);
  });

  it('does not load incident state into Health failure groups', () => {
    const data = read('app/app/(protected)/health/_lib/health-data.ts');
    expect(data).not.toContain('loadFailureIncidentStates');
  });

  it('keeps "Open incident" off team surfaces', () => {
    for (const rel of [
      'lib/home-attention.ts',
      'app/app/(protected)/tasks/[id]/page.tsx',
      'components/recovery/MissionRecoveryNotice.tsx',
      'app/app/(protected)/health/_components/FailureGroups.tsx',
    ]) expect(read(rel)).not.toContain('Open incident');
  });

  it('keeps the projection free of operator vocabulary and of the operator role', () => {
    const src = read('lib/service-status.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/isPlatformOperator|platform-operator|lib\/admin/);
    expect(src).not.toMatch(/'[^']*[Ii]ncident[^']*'/);
  });
});
