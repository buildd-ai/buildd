import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── Mocks ──────────────────────────────────────────────────────────────────────
// Only the db handle is stubbed. Schema and drizzle-orm are real, so the WHERE
// clauses the preflight builds can be rendered to SQL and asserted on — a
// mocked predicate builder would make every scoping bug unobservable.

const mockSkillsFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockAccountWorkspacesFindMany = mock((_args: any) => Promise.resolve([] as any[]));
const mockTasksFindFirst = mock((_args: any) => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock((_args: any) => Promise.resolve({ teamId: 'team-1' } as any));
let insertedTask: any = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findMany: mockSkillsFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: mock((_table: any) => ({
      values: mock((vals: any) => {
        insertedTask = vals;
        return { returning: mock(() => Promise.resolve([{ id: 'friction-task-1' }])) };
      }),
    })),
  },
}));

import {
  requiredScheduleSkillSlugs,
  findMissingScheduleSkills,
  diagnoseScheduleSkills,
  assertScheduleSkillsAvailable,
  MissingScheduleSkillError,
  fileMissingSkillFriction,
  missingSkillFrictionSignature,
} from './schedule-skill-preflight';

const dialect = new PgDialect();
function renderWhere(m: { mock: { calls: any[] } }) {
  const args = m.mock.calls.at(-1)![0] as { where: any };
  return dialect.sqlToQuery(args.where);
}

beforeEach(() => {
  mockSkillsFindMany.mockReset();
  mockSkillsFindMany.mockResolvedValue([]);
  mockAccountWorkspacesFindMany.mockReset();
  mockAccountWorkspacesFindMany.mockResolvedValue([]);
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockResolvedValue(null);
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
  insertedTask = null;
});

describe('requiredScheduleSkillSlugs', () => {
  it('reads skillSlugs from the template context, deduped, strings only', () => {
    expect(requiredScheduleSkillSlugs({ skillSlugs: ['a', 'b', 'a', 7, ''] })).toEqual(['a', 'b']);
  });

  it('returns [] when the template names no skills', () => {
    expect(requiredScheduleSkillSlugs(undefined)).toEqual([]);
    expect(requiredScheduleSkillSlugs({})).toEqual([]);
    expect(requiredScheduleSkillSlugs({ skillSlugs: 'not-an-array' })).toEqual([]);
  });
});

describe('findMissingScheduleSkills', () => {
  it('does not touch the db when no skills are required', async () => {
    expect(await findMissingScheduleSkills('ws-1', [])).toEqual([]);
    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });

  it('reports a slug with no enabled row the claim could deliver', async () => {
    mockSkillsFindMany.mockResolvedValue([{ slug: 'present', workspaceId: 'ws-1', accountId: null }]);
    const missing = await findMissingScheduleSkills('ws-1', ['present', 'example-skill']);
    expect(missing).toEqual(['example-skill']);
  });

  it('scopes the lookup to enabled rows in this workspace or its own team (no claiming accounts)', async () => {
    await findMissingScheduleSkills('ws-1', ['x']);
    const { sql, params } = renderWhere(mockSkillsFindMany);
    expect(sql).toContain('"workspace_skills"."enabled"');
    expect(sql).toContain('"workspace_skills"."workspace_id" = $');
    // Team-level rows are read only to explain a miss, never to pass one.
    expect(sql).toContain('"workspace_skills"."workspace_id" is null');
    expect(sql).toContain('"workspace_skills"."team_id" = $');
    expect(sql).not.toContain('"workspace_skills"."account_id"');
    expect(params).toContain('ws-1');
    expect(params).toContain('team-1');
    expect(params).toContain('x');
  });

  it('a workspace-scoped enabled row is deliverable', async () => {
    mockSkillsFindMany.mockResolvedValue([{ slug: 'x', workspaceId: 'ws-1', accountId: null }]);
    expect(await findMissingScheduleSkills('ws-1', ['x'])).toEqual([]);
  });

  it('a skill registered only at team level is MISSING — claims never deliver team-level skill rows', async () => {
    // list_skills shows a team-level row as registered, but attachSkillBundles
    // only reads workspace-scoped rows and the claiming account's rows. This
    // is the "registered on the platform, absent from the worktree" shape.
    mockSkillsFindMany.mockResolvedValue([{ slug: 'x', workspaceId: null, accountId: null }]);
    const diagnosis = await diagnoseScheduleSkills('ws-1', ['x']);
    expect(diagnosis).toEqual([{ slug: 'x', reason: 'team_level_only' }]);

    const err = await assertScheduleSkillsAvailable('ws-1', { skillSlugs: ['x'] }).catch(e => e);
    expect(err).toBeInstanceOf(MissingScheduleSkillError);
    expect(err.message).toContain('team level');
  });

  it('an account-level row on only SOME claiming accounts is MISSING — a claim by the other account drops it', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([{ accountId: 'acct-1' }, { accountId: 'acct-2' }]);
    mockSkillsFindMany.mockResolvedValue([{ slug: 'x', workspaceId: null, accountId: 'acct-1' }]);
    expect(await diagnoseScheduleSkills('ws-1', ['x'])).toEqual([{ slug: 'x', reason: 'not_on_every_claim_account' }]);
  });

  it('an account-level row on EVERY claiming account is deliverable whichever account claims', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([{ accountId: 'acct-1' }, { accountId: 'acct-2' }]);
    mockSkillsFindMany.mockResolvedValue([
      { slug: 'x', workspaceId: null, accountId: 'acct-1' },
      { slug: 'x', workspaceId: null, accountId: 'acct-2' },
    ]);
    expect(await findMissingScheduleSkills('ws-1', ['x'])).toEqual([]);
  });

  it('also accepts account-level rows of accounts that can claim in this workspace (the claim fallback)', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([{ accountId: 'acct-1' }]);
    await findMissingScheduleSkills('ws-1', ['x']);

    const aw = renderWhere(mockAccountWorkspacesFindMany);
    expect(aw.sql).toContain('"account_workspaces"."workspace_id" = $');
    expect(aw.sql).toContain('"account_workspaces"."can_claim" = $');
    expect(aw.params).toContain('ws-1');

    const { sql, params } = renderWhere(mockSkillsFindMany);
    expect(sql).toContain('"workspace_skills"."account_id" in');
    expect(params).toContain('acct-1');
  });
});

describe('assertScheduleSkillsAvailable', () => {
  it('throws MissingScheduleSkillError naming the missing slugs', async () => {
    const err = await assertScheduleSkillsAvailable('ws-1', { skillSlugs: ['example-skill'] }).catch(e => e);
    expect(err).toBeInstanceOf(MissingScheduleSkillError);
    expect(err.missingSlugs).toEqual(['example-skill']);
    expect(err.workspaceId).toBe('ws-1');
    expect(err.message).toContain('example-skill');
  });

  it('resolves when every required skill is available', async () => {
    mockSkillsFindMany.mockResolvedValue([{ slug: 'a', workspaceId: 'ws-1', accountId: null }]);
    await expect(assertScheduleSkillsAvailable('ws-1', { skillSlugs: ['a'] })).resolves.toBeUndefined();
  });
});

describe('fileMissingSkillFriction', () => {
  const input = {
    scheduleId: 'sched-1',
    scheduleName: 'Example schedule',
    workspaceId: 'ws-1',
    missingSlugs: ['example-skill'],
  };

  it('files one [friction] task carrying the dedupe signature', async () => {
    const outcome = await fileMissingSkillFriction(input);
    expect(outcome).toBe('created');
    expect(insertedTask.title.startsWith('[friction] ')).toBe(true);
    expect(insertedTask.title).toContain('example-skill');
    expect(insertedTask.workspaceId).toBe('ws-1');
    expect(insertedTask.context.frictionSignature).toBe(missingSkillFrictionSignature('sched-1'));
    // Not 'schedule': it has no scheduleId column and is not schedule-spawned
    // work, so it must not show up in schedule analytics.
    expect(insertedTask.creationSource).toBe('webhook');
  });

  it('files nothing when an open friction task already carries the signature', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'existing' });
    const outcome = await fileMissingSkillFriction(input);
    expect(outcome).toBe('exists');
    expect(insertedTask).toBeNull();
    const { params } = renderWhere(mockTasksFindFirst);
    expect(params).toContain(missingSkillFrictionSignature('sched-1'));
  });
});
