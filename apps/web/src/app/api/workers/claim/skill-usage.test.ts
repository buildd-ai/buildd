/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-3 (R-11..R-13). */
import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordSkillUsage } from './skill-usage';

describe('skill usage telemetry', () => {
  it('AC-3: three delivered skills are counted by one atomic upsert', async () => {
    const statements: string[] = [];
    await recordSkillUsage({ teamId: 't', skillIds: ['a', 'b', 'c'], now: new Date(), exec: async (q: string) => { statements.push(q); } });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/ON CONFLICT \(skill_id\) DO UPDATE/i);
    expect(statements[0]).toMatch(/claim_count\s*=\s*skill_usage\.claim_count\s*\+\s*1/i);
  });

  it('AC-3: a failing write does not fail the claim', async () => {
    await expect(recordSkillUsage({
      teamId: 't', skillIds: ['a'], now: new Date(), exec: async () => { throw new Error('db down'); },
    })).resolves.toBeUndefined();
  });

  it('AC-3: no db.transaction() in the usage writer', () => {
    const src = readFileSync(join(import.meta.dir, 'skill-usage.ts'), 'utf8');
    expect(src).not.toMatch(/\.transaction\(/);
  });
});

// --- claim wiring: attachSkillBundles notes delivered rows, recordClaimedSkillUsage counts them ---
const executed: any[] = [];
let execError: Error | null = null;
const skillRow = (id: string, slug: string) => ({ id, slug, name: slug, description: null, content: 'body', source: null, metadata: null });
mock.module('@buildd/core/db', () => ({
  db: {
    execute: async (stmt: any) => {
      executed.push(stmt);
      if (execError) throw execError;
      return [];
    },
    query: {
      workspaceSkills: {
        findMany: async () => [skillRow('00000000-0000-0000-0000-00000000000a', 'a'), skillRow('00000000-0000-0000-0000-00000000000b', 'b'), skillRow('00000000-0000-0000-0000-00000000000c', 'c')],
        findFirst: async () => null,
      },
    },
  },
}));
mock.module('@/lib/storage', () => ({ isStorageConfigured: () => false, generateDownloadUrl: async () => '' }));
mock.module('@/lib/body-read-monitor', () => ({ noteBodyReads: async () => {} }));

describe('recordClaimedSkillUsage (claim path)', () => {
  beforeEach(() => { executed.length = 0; execError = null; });

  const claim = async (teamId: string | undefined) => {
    const inj = await import('./skill-and-role-injection');
    const cw: any = { taskId: 't1', task: { context: { skillSlugs: ['a', 'b', 'c'] } } };
    const tasks: any[] = [{ id: 't1', workspaceId: 'w1', workspace: { teamId } }];
    await inj.attachSkillBundles([cw], tasks, 'acct');
    return { inj, cw, tasks };
  };

  it('a claim delivering three skills issues exactly one upsert raising each row by one', async () => {
    const { inj, cw, tasks } = await claim('00000000-0000-0000-0000-0000000000f1');
    await inj.recordClaimedSkillUsage([cw], tasks);
    expect(executed).toHaveLength(1);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const q = new PgDialect().sqlToQuery(executed[0]);
    expect(q.sql).toMatch(/ON CONFLICT \(skill_id\) DO UPDATE/i);
    for (const c of ['a', 'b', 'c']) expect(q.params).toContain(`00000000-0000-0000-0000-00000000000${c}`);
    expect(q.sql.match(/, 1,/g)).toHaveLength(3);
  });

  it('a thrown DB error leaves the call resolving', async () => {
    const { inj, cw, tasks } = await claim('00000000-0000-0000-0000-0000000000f1');
    execError = new Error('db down');
    await expect(inj.recordClaimedSkillUsage([cw], tasks)).resolves.toBeUndefined();
    expect(executed).toHaveLength(1);
  });

  it('a task with no workspace.teamId records nothing and does not throw', async () => {
    const { inj, cw, tasks } = await claim(undefined);
    await expect(inj.recordClaimedSkillUsage([cw], tasks)).resolves.toBeUndefined();
    expect(executed).toHaveLength(0);
  });
});
