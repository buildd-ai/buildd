import { describe, it, expect, beforeEach, mock } from 'bun:test';

let roleRow: Record<string, unknown> | undefined;
let roleRows: Array<Record<string, unknown>> | null = null;
let findFirstCalls = 0;
const teamRow = (connectorRefs: string[] | null, slug = 'builder') =>
  ({ slug, teamId: 'team-1', workspaceId: null, ownerUserId: null, visibility: 'team', connectorRefs });

// Only @buildd/core/db is stubbed. Deliberately NOT drizzle-orm or
// @buildd/core/db/schema: `mock.module` replaces a module globally for the whole
// test process and is never undone, so a partial stub of either one deletes
// exports for every sibling route test that loads later in the same run.
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: {
        findMany: () => {
          findFirstCalls++;
          return Promise.resolve(roleRows ?? (roleRow ? [roleRow] : []));
        },
      },
    },
  },
}));

const { validateRequiredConnectors, resolveRoleConnectorRefs } = await import(
  './required-connectors'
);

// The role lookup's SQL shape is asserted against the module source rather than a
// rendered predicate. Sibling lib tests stub `drizzle-orm` with a dozen
// incompatible `sql` shapes and whichever loads last wins for the whole run, so
// anything built on the real tagged-template internals is load-order dependent.
// The source text is not. (Same rationale as github-repo-link.test.ts.)
const source = await Bun.file(new URL('./required-connectors.ts', import.meta.url)).text();
const roleLookup = source.slice(
  source.indexOf('const roleRows = await db.query.workspaceSkills.findMany'),
  source.indexOf('return (roleRow?.connectorRefs'),
);

beforeEach(() => {
  roleRow = undefined;
  roleRows = null;
  findFirstCalls = 0;
});

describe('resolveRoleConnectorRefs — lookup shape', () => {
  it('scopes the role lookup by teamId', () => {
    // Regression: role slugs are seeded per team (builder/researcher/organizer
    // exist in every team) and team-wide rows carry workspaceId IS NULL, so a
    // slug-only lookup resolves another team's row — accepting a connector id
    // this team's role never declares, or rejecting one it does. The claim
    // route's own pre-filter is team-scoped for the same reason.
    expect(roleLookup).toContain('eq(workspaceSkills.teamId, teamId)');
  });

  it('still matches the workspace-scoped OR team-wide pair', () => {
    expect(roleLookup).toContain('eq(workspaceSkills.workspaceId, workspaceId)');
    expect(roleLookup).toContain('isNull(workspaceSkills.workspaceId)');
  });

  it('picks the winner by the shared role precedence, never an unordered first row', () => {
    expect(roleLookup).toContain('pickVisibleRoleRow(roleRows, roleSlug, { teamId, workspaceId, requesterUserId })');
    expect(roleLookup).toContain('personalRoleVisibleSql(requesterUserId)');
  });

  it('a workspace override beats the team default in any row order', async () => {
    const override = { ...teamRow(['c-ws']), workspaceId: 'ws-1' };
    roleRows = [teamRow(['c-team']), override];
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1')).toEqual(['c-ws']);
    roleRows = [override, teamRow(['c-team'])];
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1')).toEqual(['c-ws']);
  });

  it("reads the requester's own personal role, never another member's private one", async () => {
    roleRows = [teamRow(['c-team']), { ...teamRow(['c-bob']), id: 'r-bob', ownerUserId: 'u-bob', visibility: 'private' }];
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1', 'u-alice')).toEqual(['c-team']);
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1', 'u-bob')).toEqual(['c-bob']);
  });

  it('requires the role to be enabled', () => {
    expect(roleLookup).toContain('eq(workspaceSkills.enabled, true)');
  });
});

describe('resolveRoleConnectorRefs — result mapping', () => {
  it('returns the declared refs', async () => {
    roleRow = teamRow(['conn-a', 'conn-b'], 'researcher');
    expect(await resolveRoleConnectorRefs('researcher', 'ws-1', 'team-1')).toEqual([
      'conn-a',
      'conn-b',
    ]);
  });

  it('returns an empty list when the role declares none', async () => {
    roleRow = teamRow(null);
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1')).toEqual([]);
  });

  it('returns an empty list when no role row matches', async () => {
    roleRow = undefined;
    expect(await resolveRoleConnectorRefs('ghost', 'ws-1', 'team-1')).toEqual([]);
  });
});

describe('validateRequiredConnectors', () => {
  const ctx = { roleSlug: 'builder', workspaceId: 'ws-1', teamId: 'team-1' };

  it('treats undefined and null as no-ops', async () => {
    expect(await validateRequiredConnectors(undefined, ctx)).toEqual({ ok: true, value: null });
    expect(await validateRequiredConnectors(null, ctx)).toEqual({ ok: true, value: null });
  });

  it('accepts ids the role declares', async () => {
    roleRow = teamRow(['conn-a', 'conn-b']);
    expect(await validateRequiredConnectors(['conn-a'], ctx)).toEqual({
      ok: true,
      value: ['conn-a'],
    });
  });

  it('rejects ids the role does not declare, naming them', async () => {
    roleRow = teamRow(['conn-a']);
    const res = await validateRequiredConnectors(['conn-a', 'conn-zz'], ctx);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('conn-zz');
  });

  it('rejects a non-array and a non-string element', async () => {
    expect((await validateRequiredConnectors('conn-a', ctx)).ok).toBe(false);
    expect((await validateRequiredConnectors([1, 2], ctx)).ok).toBe(false);
  });

  it('accepts an empty array without touching the role table', async () => {
    const res = await validateRequiredConnectors([], ctx);
    expect(res).toEqual({ ok: true, value: [] });
    expect(findFirstCalls).toBe(0);
  });

  it('rejects a non-empty list when the task has no roleSlug', async () => {
    const res = await validateRequiredConnectors(['conn-a'], { ...ctx, roleSlug: null });
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('roleSlug');
  });

  it('rejects a non-empty list when the workspace has no team', async () => {
    // Without a team we cannot scope the role lookup, and an unscoped lookup is
    // exactly the bug above — so refuse rather than guess.
    const res = await validateRequiredConnectors(['conn-a'], { ...ctx, teamId: null });
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('team');
    expect(findFirstCalls).toBe(0);
  });

  it('rejects every id when the role declares none', async () => {
    roleRow = teamRow([]);
    const res = await validateRequiredConnectors(['conn-a'], ctx);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('conn-a');
  });
});
