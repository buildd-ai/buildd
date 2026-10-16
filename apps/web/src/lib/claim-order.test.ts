/**
 * lib/claim-order.ts, rendered: the claim's reach (open workspaces of the
 * account's OWN team, plus live canClaim links, cut to a restricted token's
 * list, or a grant session's grant), and the claim predicates moved here from
 * the claim route, each rendered through PgDialect so a malformed fragment is
 * visible (spec c7410e76 R-26).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const findMany = mock(async (_args: any): Promise<any[]> => []);
const permissions = mock(async (_id: string, _o?: unknown): Promise<any[]> => []);
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findMany } } } }));
mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: permissions }));

const { activeWorkerGate, claimableWorkspaceIds, runnerCooldownGate, runnerPreferenceGate, roleSlugGate } = await import('./claim-order');
const { workspaces } = await import('@buildd/core/db/schema');
const dialect = new PgDialect();
const where = (args: any) => dialect.sqlToQuery(args.where.RAW(workspaces));

describe('claimableWorkspaceIds', () => {
  beforeEach(() => {
    findMany.mockReset();
    permissions.mockReset();
    findMany.mockResolvedValue([]);
    permissions.mockResolvedValue([]);
  });

  it("reads open workspaces of the account's own team only", async () => {
    findMany.mockResolvedValueOnce([{ id: 'ws-open' }]);
    expect(await claimableWorkspaceIds({ id: 'acc-1', teamId: 'team-1' })).toEqual(['ws-open']);
    const q = where(findMany.mock.calls[0]![0]);
    expect(q.sql).toBe('(("workspaces"."access_mode" = $1) and ("workspaces"."team_id" = $2))');
    expect(q.params).toEqual(['open', 'team-1']);
  });

  it('narrows to one workspace when asked', async () => {
    await claimableWorkspaceIds({ id: 'acc-1', teamId: 'team-1' }, 'ws-x');
    const q = where(findMany.mock.calls[0]![0]);
    expect(q.sql).toBe('(("workspaces"."access_mode" = $1) and ("workspaces"."team_id" = $2) and ("workspaces"."id" = $3))');
    expect(q.params).toEqual(['open', 'team-1', 'ws-x']);
  });

  it('adds live canClaim links that still exist, and drops revoked ones even from the open arm', async () => {
    findMany.mockResolvedValueOnce([{ id: 'ws-open' }, { id: 'ws-revoked' }]).mockResolvedValueOnce([{ id: 'ws-linked' }]);
    permissions.mockResolvedValueOnce([
      { workspaceId: 'ws-linked', canClaim: true, revoked: false },
      { workspaceId: 'ws-gone', canClaim: true, revoked: false },
      { workspaceId: 'ws-readonly', canClaim: false, revoked: false },
      { workspaceId: 'ws-revoked', canClaim: true, revoked: true },
    ]);
    expect(await claimableWorkspaceIds({ id: 'acc-1', teamId: 'team-1' })).toEqual(['ws-open', 'ws-linked']);
    expect(dialect.sqlToQuery(findMany.mock.calls[1]![0].where.RAW(workspaces)).params).toEqual(['ws-linked', 'ws-gone']);
  });

  it("a workspace-restricted token claims only inside its own list", async () => {
    findMany.mockResolvedValueOnce([{ id: 'ws-a' }, { id: 'ws-b' }]);
    expect(await claimableWorkspaceIds({ id: 'acc-1', teamId: 'team-1', workspaceIds: ['ws-b'] })).toEqual(['ws-b']);
  });

  it('a grant session reads nothing and claims only its granted workspaces with write', async () => {
    const out = await claimableWorkspaceIds({ id: 'acc-1', teamId: 'team-1', oauthGrantId: 'g-1', grantScopes: ['read', 'write'], workspaceIds: ['ws-g'] });
    expect(out).toEqual(['ws-g']);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('claim predicates, rendered', () => {
  it('runnerPreferenceGate: any, or this account type', () => {
    const q = dialect.sqlToQuery(runnerPreferenceGate('service'));
    expect(q.sql).toBe('(("tasks"."runner_preference" = $1) or ("tasks"."runner_preference" = $2))');
    expect(q.params).toEqual(['any', 'service']);
  });

  it('activeWorkerGate: no live worker on the task', () => {
    const q = dialect.sqlToQuery(activeWorkerGate());
    expect(q.sql.replace(/\s+/g, ' ').trim()).toBe(
      `NOT EXISTS ( SELECT 1 FROM "workers" w WHERE w.task_id = "tasks"."id" AND w.status IN ('running', 'starting', 'waiting_input', 'idle') )`,
    );
  });

  it('runnerCooldownGate: no error or failure from this runner since the cutoff', () => {
    const cutoff = new Date('2026-03-10T15:00:00Z');
    const q = dialect.sqlToQuery(runnerCooldownGate('http://localhost:8766', cutoff));
    expect(q.sql.replace(/\s+/g, ' ').trim()).toBe(
      `NOT EXISTS ( SELECT 1 FROM "workers" w_cd WHERE w_cd.task_id = "tasks"."id" AND w_cd.runner = $1 AND w_cd.status IN ('error', 'failed') AND w_cd.updated_at > $2 )`,
    );
    expect(q.params[0]).toBe('http://localhost:8766');
  });

  it('roleSlugGate keeps an unrouted task claimable', () => {
    const q = dialect.sqlToQuery(roleSlugGate(['builder'])[1]!);
    expect(q.sql).toContain('"tasks"."role_slug" is null');
    expect(q.params).toContain('builder');
  });
});
