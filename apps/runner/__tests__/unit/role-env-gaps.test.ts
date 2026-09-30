/**
 * Regression (task 026d6714): a role declaring BUILDD_API_KEY — every seeded
 * default role does — was reported "Role env degraded: missing BUILDD_API_KEY"
 * on every task, although the runner holds that key itself and bakes it into
 * the buildd MCP header. And a genuinely missing var logged the same warning
 * once per worker, forever. `unmetRoleEnv` reconciles the server's missing
 * list against what this runner actually supplies; `RoleEnvGapLog` warns once
 * per distinct (role, vars) gap and keeps it visible for /api/debug/internals.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/role-env-gaps.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { unmetRoleEnv, RoleEnvGapLog } from '../../src/roles';

describe('unmetRoleEnv', () => {
  test('drops a var the runner supplies through any channel', () => {
    expect(unmetRoleEnv(['BUILDD_API_KEY', 'SERVICE_API_KEY'], { BUILDD_API_KEY: 'bld_x' })).toEqual(['SERVICE_API_KEY']);
  });

  test('keeps a var that is absent or empty', () => {
    expect(unmetRoleEnv(['A', 'B'], { A: '' })).toEqual(['A', 'B']);
  });

  test('dedupes (file-based + claim-delivered lists can both name a var)', () => {
    expect(unmetRoleEnv(['A', 'A'], {})).toEqual(['A']);
  });
});

describe('RoleEnvGapLog', () => {
  test('first sighting of a gap says warn, repeats do not', () => {
    const log = new RoleEnvGapLog();
    expect(log.record('mailer', ['B', 'A'], 1000)).toBe(true);
    expect(log.record('mailer', ['A', 'B'], 2000)).toBe(false);
    expect(log.record('mailer', ['A'], 3000)).toBe(true); // a different gap is news
    expect(log.record('reviewer', ['A'], 4000)).toBe(true);
  });

  test('snapshot lists each gap with its count and first/last seen', () => {
    const log = new RoleEnvGapLog();
    log.record('mailer', ['A', 'B'], 1000);
    log.record('mailer', ['B', 'A'], 5000);
    expect(log.snapshot()).toEqual([
      { role: 'mailer', missing: ['A', 'B'], workers: 2, firstSeen: 1000, lastSeen: 5000 },
    ]);
  });
});
