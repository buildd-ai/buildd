/**
 * T26 on a base with no CI of its own (seam `recheckTrunkIncidents`, trunk.ts `trunkFixLandedGreen`).
 * A mission branch's pushes run no gating workflow, so the base head carries no check runs and its
 * reading is unknown at every recheck. The incident's fix PR, merged into that base with its own
 * checks green and contained in the base head, is the recovery signal: one recheck resolves it,
 * instead of the blocked PRs waiting for the hourly floor.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { CheckRunsRead, GithubFactReader, LivePr } from '@buildd/workflow-kernel/ports';

const { recheckTrunkIncidents } = await import('./seam');

const dialect = new PgDialect();
const BASE = 'mission/windows-delivery-3';
const SIG = 'ci:db architecture';
const INC = { id: 'inc-1', workspace_id: 'w1', repo_full_name: 'acme/r', base_ref: BASE, signature: SIG, trunk_fix_task_id: 'fix-task' };

function harness(o: { baseRuns?: CheckRunsRead | null; fixPr?: Partial<LivePr> | null; fixRuns?: CheckRunsRead | null; contains?: boolean; fixTask?: string | null } = {}) {
  const resolved: string[] = [];
  const exec = async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql;
    if (text.includes('workflow:trunk_unresolved_by_id')) return { rows: [{ ...INC, trunk_fix_task_id: o.fixTask === undefined ? INC.trunk_fix_task_id : o.fixTask }] };
    if (text.includes('workflow:task_prs')) return { rows: [{ id: 'fix-task', pr: { prUrl: 'https://github.com/acme/r/pull/47', prNumber: 47 } }] };
    if (text.includes('workflow:trunk_resolve')) { resolved.push(INC.id); return { rows: [{ id: INC.id }] }; }
    return { rows: [] };
  };
  const pr: LivePr | null = o.fixPr === null ? null : {
    state: 'closed', merged: true, headSha: 'FIXHEAD', headRepoFullName: 'acme/r', baseRef: BASE, mergeCommitSha: 'MERGE', ...o.fixPr,
  };
  const reader: GithubFactReader = {
    readPr: async (_r, n) => (n === 47 ? pr : null),
    branchHead: async () => 'BASEHEAD',
    checkRuns: async (_r, sha) => (sha === 'BASEHEAD' ? (o.baseRuns === undefined ? null : o.baseRuns) : sha === 'FIXHEAD' ? (o.fixRuns === undefined ? { complete: true, failing: [], tests: [], pending: [] } : o.fixRuns) : null),
    contains: async (_r, ancestor, head) => ancestor === 'MERGE' && head === 'BASEHEAD' && (o.contains ?? true),
  };
  const deps = { exec, reader: () => reader, repoFor: async () => ({ installationId: 1, repoFullName: 'acme/r', gitConfig: null }), drain: async () => null } as never;
  return { resolved, run: () => recheckTrunkIncidents([INC.id], deps) };
}

describe('trunk recovery on a base with no CI of its own', () => {
  test('a base head with zero check runs and the fix PR merged green: one recheck resolves it', async () => {
    const h = harness();
    const out = await h.run();
    expect(h.resolved).toEqual([INC.id]);
    expect(out.unresolved).toEqual([]);
    expect(out.resolved).toBe(1);
  });

  test('the fix PR still failing the incident\'s checks leaves it unresolved', async () => {
    const h = harness({ fixRuns: { complete: true, failing: ['DB architecture'], tests: ['DB architecture'], pending: [] } });
    expect((await h.run()).unresolved).toEqual([INC.id]);
    expect(h.resolved).toEqual([]);
  });

  test('the fix PR\'s checks still running leave it unresolved', async () => {
    const h = harness({ fixRuns: { complete: false, failing: [], tests: [], pending: ['DB architecture'] } });
    expect((await h.run()).unresolved).toEqual([INC.id]);
  });

  test('a fix PR not merged, or merged into another base, is no evidence', async () => {
    expect((await harness({ fixPr: { merged: false, mergeCommitSha: null } }).run()).unresolved).toEqual([INC.id]);
    expect((await harness({ fixPr: { baseRef: 'dev' } }).run()).unresolved).toEqual([INC.id]);
  });

  test('a base head that does not contain the fix\'s merge is no evidence', async () => {
    expect((await harness({ contains: false }).run()).unresolved).toEqual([INC.id]);
  });

  test('an incident with no fix task stays on the base\'s own reading', async () => {
    expect((await harness({ fixTask: null }).run()).unresolved).toEqual([INC.id]);
  });

  test('a base that reports runs is read by them alone: still red stays red whatever the fix PR says', async () => {
    const h = harness({ baseRuns: { complete: true, failing: ['DB architecture'], tests: ['DB architecture'], pending: [] } });
    expect((await h.run()).unresolved).toEqual([INC.id]);
    expect(h.resolved).toEqual([]);
  });
});
