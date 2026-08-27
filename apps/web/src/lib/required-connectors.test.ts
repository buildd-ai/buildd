import { describe, it, expect, beforeEach, mock } from 'bun:test';

let roleRow: { connectorRefs: string[] | null } | undefined;
let findFirstCalls = 0;

// Only @buildd/core/db is stubbed. Deliberately NOT drizzle-orm or
// @buildd/core/db/schema: `mock.module` replaces a module globally for the whole
// test process and is never undone, so a partial stub of either one deletes
// exports for every sibling route test that loads later in the same run.
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: {
        findFirst: () => {
          findFirstCalls++;
          return Promise.resolve(roleRow);
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
  source.indexOf('const roleRow = await db.query.workspaceSkills.findFirst'),
  source.indexOf('return (roleRow?.connectorRefs'),
);

beforeEach(() => {
  roleRow = undefined;
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

  it('orders workspace-scoped rows ahead of the team-wide row', () => {
    expect(roleLookup).toContain('desc(ws.workspaceId)');
  });

  it('requires the role to be enabled', () => {
    expect(roleLookup).toContain('eq(workspaceSkills.enabled, true)');
  });
});

describe('resolveRoleConnectorRefs — result mapping', () => {
  it('returns the declared refs', async () => {
    roleRow = { connectorRefs: ['conn-a', 'conn-b'] };
    expect(await resolveRoleConnectorRefs('researcher', 'ws-1', 'team-1')).toEqual([
      'conn-a',
      'conn-b',
    ]);
  });

  it('returns an empty list when the role declares none', async () => {
    roleRow = { connectorRefs: null };
    expect(await resolveRoleConnectorRefs('builder', 'ws-1', 'team-1')).toEqual([]);
  });

  it('returns an empty list when no role row matches', async () => {
    roleRow = undefined;
    expect(await resolveRoleConnectorRefs('ghost', 'ws-1', 'team-1')).toEqual([]);
  });
});

describe('validateRequiredConnectors', () => {
  const ctx = { roleSlug: 'researcher', workspaceId: 'ws-1', teamId: 'team-1' };

  it('treats undefined and null as no-ops', async () => {
    expect(await validateRequiredConnectors(undefined, ctx)).toEqual({ ok: true, value: null });
    expect(await validateRequiredConnectors(null, ctx)).toEqual({ ok: true, value: null });
  });

  it('accepts ids the role declares', async () => {
    roleRow = { connectorRefs: ['conn-a', 'conn-b'] };
    expect(await validateRequiredConnectors(['conn-a'], ctx)).toEqual({
      ok: true,
      value: ['conn-a'],
    });
  });

  it('rejects ids the role does not declare, naming them', async () => {
    roleRow = { connectorRefs: ['conn-a'] };
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
    roleRow = { connectorRefs: [] };
    const res = await validateRequiredConnectors(['conn-a'], ctx);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('conn-a');
  });
});
