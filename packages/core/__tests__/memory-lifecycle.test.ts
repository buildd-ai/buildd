/**
 * The memory lifecycle pass (./memory-lifecycle): extraction, promotion,
 * expiry, re-verify flags.
 *
 * Every query is rendered through PgDialect, so the scoping (team, project,
 * state, the external floor, the windows and caps) is observed in the SQL
 * rather than assumed from a mocked db that would return its seeded rows
 * whatever the WHERE said. The orchestration runs over injected deps.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  changesRequestedReviewsQuery,
  expireCandidatesSql,
  failedTasksForExtractionQuery,
  flaggedWorkspacesQuery,
  flagReverifySql,
  memorySourceTaskSql,
  mergedPrJobsQuery,
  promoteCandidatesSql,
  promotionCandidatesQuery,
  runMemoryLifecycle,
  type LifecycleDeps,
  type PromotionCandidateRow,
} from '../memory-lifecycle';
import {
  MEMORY_EXTRACT_MAX_PER_RUN,
  MEMORY_PROMOTE_MAX_PER_RUN,
  MEMORY_PROMOTE_SHADOW_MAX_PER_RUN,
} from '../memory-candidates';
import type { MemoryDecider, PromoteShadowItem } from '../memory-decisions';

const dialect = new PgDialect();
const render = (q: any) => {
  const out = dialect.sqlToQuery(q);
  return { sql: out.sql.replace(/\s+/g, ' '), params: out.params };
};

const TEAM = 'bbbb0000-0000-0000-0000-000000000001';
const WS = 'aaaa0000-0000-0000-0000-000000000000';

describe('memorySourceTaskSql', () => {
  it('reads the task from source_id for learn / failed_task, else from the worker in source, with guarded casts', () => {
    const { sql } = render(memorySourceTaskSql('m'));
    expect(sql).toContain("m.source_kind IN ('learn', 'failed_task') AND m.source_id ~");
    expect(sql).toContain('THEN m.source_id::uuid END');
    expect(sql).toContain("m.source LIKE 'worker:%'");
    expect(sql).toContain('sw.id = substr(m.source, 8)::uuid');
  });
});

describe('promotionCandidatesQuery', () => {
  const { sql, params } = render(promotionCandidatesQuery(500));

  it('reads current candidates with a project only, oldest first, capped', () => {
    expect(sql).toContain("WHERE m.state = 'candidate' AND m.superseded_by IS NULL AND m.project IS NOT NULL");
    expect(sql).toContain('ORDER BY m.created_at ASC');
    expect(params).toContain(MEMORY_PROMOTE_MAX_PER_RUN);
  });

  it('counts a merged PR only once the 72h revert window has passed', () => {
    expect(sql).toContain('pr.merged_at <= now() - make_interval(hours => $1)');
    expect(params[0]).toBe(72);
  });

  it('sees a revert as a buildd revert task or an identical-file-list merge inside the window, in the same workspace', () => {
    expect(sql).toContain('rw.workspace_id = pr.workspace_id');
    expect(sql).toContain("rt.title ILIKE 'revert%'");
    expect(sql).toMatch(/rw\.merged_at <= pr\.merged_at \+ make_interval\(hours => \$\d+\)/);
    expect(sql).toContain('jr.changed_files @> js.changed_files AND js.changed_files @> jr.changed_files');
    expect(sql).toContain('js.workspace_id = pr.workspace_id');
  });

  it('corroboration is a same-team, same-project, non-external row from a different task folded into this one', () => {
    expect(sql).toContain('m2.team_id = m.team_id');
    expect(sql).toContain('m2.project = m.project');
    expect(sql).toContain('m2.superseded_by = m.id');
    expect(sql).toContain('m2.external = false');
    expect(sql).toContain("m.source_kind = 'learn' AND src.task_id IS NOT NULL");
    expect(sql).toMatch(/<> src\.task_id/);
  });
});

describe('promoteCandidatesSql', () => {
  it('re-checks team, state and the external floor in the UPDATE, and binds ids as one array', () => {
    const { sql, params } = render(promoteCandidatesSql(TEAM, ['m1', 'm2']));
    expect(sql).toContain("SET state = 'active', valid_from = now()");
    expect(sql).toContain('WHERE team_id = $1');
    expect(sql).toContain('id IN ($2::uuid, $3::uuid)');
    expect(sql).toContain("AND state = 'candidate' AND external = false AND superseded_by IS NULL");
    expect(params).toEqual([TEAM, 'm1', 'm2']);
  });
});

describe('expireCandidatesSql', () => {
  it('expires old candidates with no pull and no used outcome, same team, bounded; never deletes', () => {
    const { sql, params } = render(expireCandidatesSql(30, 999));
    expect(sql).toContain("UPDATE memories SET state = 'expired'");
    expect(sql).not.toContain('DELETE');
    expect(sql).toContain('m.created_at < now() - make_interval(days => $1)');
    expect(sql).toContain('u.team_id = m.team_id AND u.memory_id = m.id::text');
    expect(sql).toContain("(u.via = 'pull' OR u.outcome = 'used')");
    expect(params).toEqual([30, 50]);
  });
});

describe('empty id lists', () => {
  it('match nothing instead of rendering an invalid IN ()', () => {
    expect(render(promoteCandidatesSql(TEAM, [])).sql).toContain('id IN (NULL::uuid)');
    expect(render(failedTasksForExtractionQuery([], 24, 1)).sql).toContain('t.workspace_id IN (NULL::uuid)');
  });
});

describe('extraction queries', () => {
  it('flagged workspaces: literal true only, never sensitive', () => {
    const { sql, params } = render(flaggedWorkspacesQuery());
    expect(sql).toContain("git_config -> $1 = 'true'::jsonb");
    expect(sql).toContain("data_class IS DISTINCT FROM 'sensitive'");
    expect(params).toEqual(['memoryCandidateWrites']);
  });

  it('failed tasks: only these workspaces, failed, recent, not extracted yet, capped', () => {
    const { sql, params } = render(failedTasksForExtractionQuery([WS], 24, 100));
    expect(sql).toContain('t.workspace_id IN ($1::uuid)');
    expect(sql).toContain("t.status = 'failed'");
    expect(sql).toContain('make_interval(hours => $2)');
    expect(sql).toContain("m.source_kind = 'failed_task' AND m.source_id = t.id::text");
    expect(params).toEqual([WS, 24, MEMORY_EXTRACT_MAX_PER_RUN]);
  });

  it('reviews: changes requested on a task PR in these workspaces, not extracted yet', () => {
    const { sql, params } = render(changesRequestedReviewsQuery([WS], 24, 3));
    expect(sql).toContain('r.workspace_id IN ($1::uuid)');
    expect(sql).toContain("r.kind = 'review' AND r.state = 'changes_requested' AND r.task_id IS NOT NULL");
    expect(sql).toContain("m.source_kind = 'review' AND m.source_id = r.id::text");
    expect(sql).toContain('c.workspace_id = r.workspace_id AND c.pr_number = r.pr_number');
    expect(params).toEqual([WS, 24, 3]);
  });
});

describe('re-verify', () => {
  it('merged-PR jobs: only these workspaces, finished pr_merged jobs', () => {
    const { sql } = render(mergedPrJobsQuery([WS], 24, 5));
    expect(sql).toContain('j.workspace_id IN ($1::uuid)');
    expect(sql).toContain("j.trigger = 'pr_merged' AND j.status = 'done'");
  });

  it('flags current rows in one team and project whose files overlap, written before the merge, not the memory\'s own PR', () => {
    const mergedAt = new Date('2026-09-01T00:00:00.000Z');
    const { sql, params } = render(flagReverifySql({ teamId: TEAM, project: 'acme/widgets', workspaceId: WS, prNumber: 12, files: ['src/a.ts'], mergedAt })!);
    expect(sql).toContain('SET reverify_flagged_at = now(), reverify_ref = $1');
    expect(sql).toContain('WHERE team_id = $2 AND project = $3');
    expect(sql).toContain("state IN ('active', 'candidate') AND reverify_flagged_at IS NULL");
    expect(sql).toContain('created_at < $4::timestamptz');
    expect(sql).toContain('unnest("memories"."files")');
    expect(sql).toContain('ow.workspace_id = $6 AND ow.pr_number = $7');
    expect(sql).not.toContain('state = \'expired\'');
    expect(params).toEqual(['pr:12', TEAM, 'acme/widgets', mergedAt.toISOString(), ['src/a.ts'], WS, 12]);
  });

  it('no files: no statement', () => {
    expect(flagReverifySql({ teamId: TEAM, project: 'p', workspaceId: WS, prNumber: 1, files: [], mergedAt: new Date() })).toBeNull();
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

const cand = (id: string, over: Partial<PromotionCandidateRow['evidence']> = {}, teamId = TEAM): PromotionCandidateRow => ({
  id, teamId, project: 'p', type: 'gotcha', title: `t ${id}`, content: `c ${id}`, sourceKind: 'learn',
  evidence: { external: false, sourcePrMergedPastWindow: false, sourcePrReverted: false, corroborated: false, ...over },
});

function fakeDeps(over: Partial<LifecycleDeps> = {}) {
  const calls = { promote: [] as Array<{ teamId: string; ids: string[] }>, written: [] as any[], flagged: [] as any[], expire: [] as any[] };
  const deps: LifecycleDeps = {
    flaggedWorkspaces: async () => [],
    findPromotionCandidates: async () => [],
    promote: async (teamId, ids) => { calls.promote.push({ teamId, ids }); return ids; },
    expire: async (d, l) => { calls.expire.push({ d, l }); return 0; },
    findFailedTasks: async () => [],
    findChangesRequestedReviews: async () => [],
    writeCandidate: async (ws, c, taskId) => { calls.written.push({ ws, c, taskId }); return 'written'; },
    findMergedPrJobs: async () => [],
    flagReverify: async (t) => { calls.flagged.push(t); return 1; },
    ...over,
  };
  return { deps, calls };
}

describe('runMemoryLifecycle', () => {
  it('with no flagged workspace and no candidates, writes nothing', async () => {
    const { deps, calls } = fakeDeps({
      findFailedTasks: async () => { throw new Error('must not be asked'); },
      findMergedPrJobs: async () => { throw new Error('must not be asked'); },
    });
    const r = await runMemoryLifecycle({ deps });
    expect(r).toMatchObject({ promoted: 0, held: 0, expired: 0, reverifyFlagged: 0, errors: 0 });
    expect(calls.promote).toHaveLength(0);
    expect(calls.written).toHaveLength(0);
  });

  it('promotes by the deterministic rule, per team, and holds the rest', async () => {
    const other = 'dddd0000-0000-0000-0000-000000000003';
    const { deps, calls } = fakeDeps({
      findPromotionCandidates: async () => [
        cand('merged', { sourcePrMergedPastWindow: true }),
        cand('corr', { corroborated: true }, other),
        cand('none'),
        cand('ext', { external: true, sourcePrMergedPastWindow: true, corroborated: true }),
        cand('rev', { sourcePrMergedPastWindow: true, sourcePrReverted: true }),
      ],
    });
    const r = await runMemoryLifecycle({ deps });
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['merged'] }, { teamId: other, ids: ['corr'] }]);
    expect(r.promoted).toBe(2);
    expect(r.held).toBe(3);
  });

  it('asks Jev promote in shadow for non-external candidates, capped, and never acts on it', async () => {
    const asked: PromoteShadowItem[][] = [];
    const decider = { shadowPromote: async ({ items }: { items: PromoteShadowItem[] }) => { asked.push(items); } } as unknown as MemoryDecider;
    const many = Array.from({ length: MEMORY_PROMOTE_SHADOW_MAX_PER_RUN + 3 }, (_, i) => cand(`c${i}`));
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('ext', { external: true }), cand('m', { sourcePrMergedPastWindow: true }), ...many] });
    const r = await runMemoryLifecycle({ deps, decider });
    const items = asked.flat();
    expect(items).toHaveLength(MEMORY_PROMOTE_SHADOW_MAX_PER_RUN);
    expect(items.some(i => i.memoryId === 'ext')).toBe(false);
    expect(items.find(i => i.memoryId === 'm')!.rule).toBe('promote');
    expect(items.find(i => i.memoryId === 'c0')!.rule).toBe('hold:no_evidence');
    expect(r.shadowed).toBe(MEMORY_PROMOTE_SHADOW_MAX_PER_RUN);
    // Only the deterministic rule promoted.
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['m'] }]);
  });

  it('extracts failed tasks then reviews, only in flagged workspaces, within one budget', async () => {
    const ws = { id: WS, teamId: TEAM, project: 'acme/widgets' };
    const failed = Array.from({ length: MEMORY_EXTRACT_MAX_PER_RUN - 1 }, (_, i) => ({
      id: `t${i}`, workspaceId: WS, title: `task ${i}`, summary: 's', error: 'e', files: [],
    }));
    const { deps, calls } = fakeDeps({
      flaggedWorkspaces: async () => [ws],
      findFailedTasks: async (ids, _w, limit) => { expect(ids).toEqual([WS]); return failed.slice(0, limit); },
      findChangesRequestedReviews: async (_ids, _w, limit) => {
        expect(limit).toBe(1);
        return [
          { id: 'r1', workspaceId: WS, taskId: 'tr', prNumber: 5, body: 'no', files: ['a.ts'] },
          { id: 'r2', workspaceId: 'unflagged-ws', taskId: 'tr', prNumber: 6, body: 'no', files: [] },
        ];
      },
    });
    const r = await runMemoryLifecycle({ deps });
    expect(calls.written).toHaveLength(MEMORY_EXTRACT_MAX_PER_RUN);
    expect(calls.written.every(w => w.ws === ws)).toBe(true);
    const review = calls.written.at(-1);
    expect(review.c.provenance).toEqual({ kind: 'review', id: 'r1', external: true });
    expect(review.taskId).toBe('tr');
    expect(r.extracted).toEqual({ failedTasks: MEMORY_EXTRACT_MAX_PER_RUN - 1, reviews: 1, duplicates: 0, failed: 0 });
  });

  it('counts duplicates and failed writes separately', async () => {
    const outs = ['duplicate', 'failed', 'written'] as const;
    let i = 0;
    const { deps } = fakeDeps({
      flaggedWorkspaces: async () => [{ id: WS, teamId: TEAM, project: 'p' }],
      findFailedTasks: async () => outs.map((_, k) => ({ id: `t${k}`, workspaceId: WS, title: 'x', summary: 's', error: null, files: [] })),
      writeCandidate: async () => outs[i++],
    });
    const r = await runMemoryLifecycle({ deps });
    expect(r.extracted).toEqual({ failedTasks: 1, reviews: 0, duplicates: 1, failed: 1 });
  });

  it('flags re-verify under the flagged workspace\'s own team and project', async () => {
    const mergedAt = new Date();
    const { deps, calls } = fakeDeps({
      flaggedWorkspaces: async () => [{ id: WS, teamId: TEAM, project: 'acme/widgets' }],
      findMergedPrJobs: async () => [
        { workspaceId: WS, prNumber: 9, files: ['a.ts'], mergedAt },
        { workspaceId: WS, prNumber: 10, files: [], mergedAt },
        { workspaceId: 'other', prNumber: 11, files: ['a.ts'], mergedAt },
      ],
    });
    const r = await runMemoryLifecycle({ deps });
    expect(calls.flagged).toEqual([{ teamId: TEAM, project: 'acme/widgets', workspaceId: WS, prNumber: 9, files: ['a.ts'], mergedAt }]);
    expect(r.reverifyFlagged).toBe(1);
  });

  it('a failing step is counted and the others still run', async () => {
    const warn = console.warn;
    console.warn = () => {};
    const { deps, calls } = fakeDeps({
      findPromotionCandidates: async () => { throw new Error('db down'); },
      expire: async () => 4,
    });
    const r = await runMemoryLifecycle({ deps });
    console.warn = warn;
    expect(r.errors).toBe(1);
    expect(r.expired).toBe(4);
    expect(calls.promote).toHaveLength(0);
  });
});
