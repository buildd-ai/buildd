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
  deferPromotionSql,
  applyPendingSupersedesSql,
  clearPendingSupersedesSql,
  flipSupersededChunkSql,
  recordExtractionAttemptSql,
  runMemoryLifecycle,
  type LifecycleDeps,
  type PromotionCandidateRow,
  cronStepBudgetMs,
  lifecycleDeadlineMs,
  MEMORY_LIFECYCLE_DEADLINE_MS,
} from '../memory-lifecycle';
import {
  MEMORY_EXTRACT_MAX_PER_RUN,
  MEMORY_PROMOTE_MAX_PER_RUN,
  MEMORY_PROMOTE_SHADOW_MAX_PER_RUN,
} from '../memory-candidates';
import {
  KEEP_NOT_DURABLE_TAG,
  PROMOTE_DEFERRED_TAG,
  type MemoryDecider,
  type PromoteItem,
  type PromoteVerdict,
} from '../memory-decisions';

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

  it('never reads a sensitive workspace key: promotion (and the Jev shadow over the same rows) skips it', () => {
    const q = render(promotionCandidatesQuery(500, [{ teamId: TEAM, project: 'acme/secret' }]));
    expect(q.sql).toContain('AND (m.team_id::text, m.project) NOT IN ((');
    expect(q.params).toEqual(expect.arrayContaining([TEAM, 'acme/secret']));
    // No sensitive keys: no clause at all (and no empty NOT IN).
    expect(sql).not.toContain('NOT IN (())');
    expect(sql).not.toContain('m.project) NOT IN');
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

  it('also sees a revert recorded from GitHub after the merge: a later PR naming the source PR, or a commit reverting its merge sha', () => {
    expect(sql).toContain('FROM pr_reverts rv');
    expect(sql).toContain('rv.workspace_id = pr.workspace_id');
    expect(sql).toContain('rv.created_at > pr.merged_at');
    expect(sql).toContain('rv.reverted_pr_number = pr.pr_number');
    // The source PR's merge sha is the one its merge ingest job recorded; an
    // abbreviated sha in a revert message matches by prefix.
    expect(sql).toContain("sj.workspace_id = pr.workspace_id AND sj.pr_number = pr.pr_number AND sj.trigger = 'pr_merged'");
    expect(sql).toContain('starts_with(sj.sha, rv.reverted_sha)');
  });

  it('corroboration is ONLY the corroborated_by link, to an own-project candidate or active row from a different task', () => {
    expect(sql).toContain("m.source_kind = 'learn' AND src.task_id IS NOT NULL AND m.corroborated_by IS NOT NULL");
    expect(sql).toContain('m2.id = m.corroborated_by');
    expect(sql).toContain('m2.team_id = m.team_id');
    expect(sql).toContain('m2.project = m.project');
    expect(sql).toContain("m2.state IN ('candidate', 'active')");
    expect(sql).toContain('m2.external = false');
    expect(sql).toMatch(/<> src\.task_id/);
  });

  it('superseded_by is not evidence of anything (explicit and band supersedes set it)', () => {
    expect(sql).not.toContain('superseded_by = m.id');
  });

  it('reads the keep tag, the deferral tag, and whether an agent pulled or used it (expiry\'s test, same team)', () => {
    expect(sql).toMatch(/\$\d+ = ANY\(m\.tags\)\) AS not_durable/);
    expect(sql).toMatch(/\$\d+ = ANY\(m\.tags\)\) AS promote_deferred/);
    expect(params).toEqual(expect.arrayContaining([KEEP_NOT_DURABLE_TAG, PROMOTE_DEFERRED_TAG]));
    expect(sql).toContain("u.team_id = m.team_id AND u.memory_id = m.id::text AND (u.via = 'pull' OR u.outcome = 'used') ) AS pulled");
  });
});

describe('promoteCandidatesSql', () => {
  it('re-checks team, state and the external floor in the UPDATE, and binds ids as one array', () => {
    const { sql, params } = render(promoteCandidatesSql(TEAM, ['m1', 'm2']));
    expect(sql).toContain("SET state = 'active', valid_from = now()");
    expect(sql).toContain('WHERE team_id = $2');
    expect(sql).toContain('id IN ($3::uuid, $4::uuid)');
    expect(sql).toContain("AND state = 'candidate' AND external = false AND superseded_by IS NULL");
    expect(params).toEqual([PROMOTE_DEFERRED_TAG, TEAM, 'm1', 'm2']);
  });

  it('clears the deferral tag on promotion', () => {
    const { sql } = render(promoteCandidatesSql(TEAM, ['m1']));
    expect(sql).toContain('tags = array_remove(tags, $1)');
  });
});

describe('deferPromotionSql', () => {
  it('tags only current non-external candidates of this team, once; never changes state', () => {
    const { sql, params } = render(deferPromotionSql(TEAM, ['m1']));
    expect(sql).toContain('SET tags = array_append(tags, $1)');
    expect(sql).toContain('WHERE team_id = $2 AND id IN ($3::uuid)');
    expect(sql).toContain("AND state = 'candidate' AND external = false AND superseded_by IS NULL AND NOT ($4 = ANY(tags))");
    expect(sql).not.toContain('SET state');
    expect(params).toEqual([PROMOTE_DEFERRED_TAG, TEAM, 'm1', PROMOTE_DEFERRED_TAG]);
  });
});

describe('deferred supersedes on promotion', () => {
  it('supersedes only the promoted rows\' pending targets, in the same team and project, and returns pairs', () => {
    const { sql, params } = render(applyPendingSupersedesSql(TEAM, ['p1']));
    expect(sql).toContain('SET superseded_by = p.id, invalidated_at = COALESCE(t.invalidated_at, now())');
    expect(sql).toContain('p.id IN ($1::uuid) AND p.team_id = $2');
    expect(sql).toContain("p.state = 'active'");
    expect(sql).toContain('t.team_id = p.team_id AND t.project = p.project');
    expect(sql).toContain('t.id = ANY(p.pending_supersedes)');
    expect(sql).toContain('t.superseded_by IS NULL');
    expect(sql).toContain('RETURNING t.id AS id, p.id AS by_id');
    expect(params).toEqual(['p1', TEAM]);
  });

  it('flips the superseded chunk in its own team namespace, and clears the list', () => {
    const flip = render(flipSupersededChunkSql(TEAM, 'old', 'new'));
    expect(flip.sql).toContain('SET is_current = false, superseded_by = $1 WHERE namespace = $2 AND source_id = $3');
    expect(flip.params).toEqual(['new', `${TEAM}:memory`, 'old']);
    const clear = render(clearPendingSupersedesSql(TEAM, ['p1']));
    expect(clear.sql).toContain("SET pending_supersedes = '{}' WHERE team_id = $1 AND id IN ($2::uuid)");
  });
});

describe('extraction attempts', () => {
  it('both extraction queries skip an episode already attempted', () => {
    expect(render(failedTasksForExtractionQuery([WS], 24, 1)).sql)
      .toContain("a.source_kind = 'failed_task' AND a.source_id = t.id::text");
    expect(render(changesRequestedReviewsQuery([WS], 24, 1)).sql)
      .toContain("a.source_kind = 'review' AND a.source_id = r.id::text");
  });

  it('records an attempt idempotently', () => {
    const { sql, params } = render(recordExtractionAttemptSql({ workspaceId: WS, sourceKind: 'review', sourceId: 'r1', outcome: 'duplicate' }));
    expect(sql).toContain('INSERT INTO memory_extraction_attempts (workspace_id, source_kind, source_id, outcome)');
    expect(sql).toContain('ON CONFLICT (source_kind, source_id) DO NOTHING');
    expect(params).toEqual([WS, 'review', 'r1', 'duplicate']);
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

const cand = (id: string, over: Partial<PromotionCandidateRow['evidence']> = {}, teamId = TEAM, promoteDeferred = false): PromotionCandidateRow => ({
  id, teamId, project: 'p', type: 'gotcha', title: `t ${id}`, content: `c ${id}`, sourceKind: 'learn', promoteDeferred,
  evidence: { external: false, sourcePrMergedPastWindow: false, sourcePrReverted: false, corroborated: false, ...over },
});

/** A decider that vetoes the live items named, and records what it was asked. */
function vetoing(veto: string[] = []) {
  const asked: PromoteItem[][] = [];
  const decider = {
    judgePromote: async ({ items }: { items: PromoteItem[] }): Promise<PromoteVerdict[]> => {
      asked.push(items);
      return items.map(i => ({ memoryId: i.memoryId, veto: i.live && veto.includes(i.memoryId) }));
    },
  } as unknown as MemoryDecider;
  return { decider, asked };
}

function fakeDeps(over: Partial<LifecycleDeps> = {}) {
  const calls = {
    promote: [] as Array<{ teamId: string; ids: string[] }>, written: [] as any[], flagged: [] as any[], expire: [] as any[],
    applied: [] as Array<{ teamId: string; ids: string[] }>, attempts: [] as any[],
    deferred: [] as Array<{ teamId: string; ids: string[] }>,
  };
  const deps: LifecycleDeps = {
    flaggedWorkspaces: async () => [],
    findPromotionCandidates: async () => [],
    promote: async (teamId, ids) => { calls.promote.push({ teamId, ids }); return ids; },
    applyPendingSupersedes: async (teamId, ids) => { calls.applied.push({ teamId, ids }); return 0; },
    deferPromotion: async (teamId, ids) => { calls.deferred.push({ teamId, ids }); return ids; },
    recordAttempt: async (a) => { calls.attempts.push(a); },
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

  it('asks Jev promote for non-external candidates, capped; a challenger the rule held never promotes', async () => {
    const { decider, asked } = vetoing();
    const many = Array.from({ length: MEMORY_PROMOTE_SHADOW_MAX_PER_RUN + 3 }, (_, i) => cand(`c${i}`));
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('ext', { external: true }), ...many, cand('m', { sourcePrMergedPastWindow: true })] });
    const r = await runMemoryLifecycle({ deps, decider });
    const items = asked.flat();
    expect(items).toHaveLength(MEMORY_PROMOTE_SHADOW_MAX_PER_RUN);
    expect(items.some(i => i.memoryId === 'ext')).toBe(false);
    // The rule-promoted item is asked first (live), even though it came last.
    expect(items[0]).toMatchObject({ memoryId: 'm', rule: 'promote', live: true });
    expect(items.find(i => i.memoryId === 'c0')).toMatchObject({ rule: 'hold:no_evidence', live: false });
    expect(r.shadowed).toBe(MEMORY_PROMOTE_SHADOW_MAX_PER_RUN - 1);
    expect(r.vetoAsked).toBe(1);
    // Only the deterministic rule promoted.
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['m'] }]);
  });

  it('Jev saying promote never promotes what the rule held', async () => {
    const decider = {
      judgePromote: async ({ items }: { items: PromoteItem[] }) => items.map(i => ({ memoryId: i.memoryId, veto: false })),
    } as unknown as MemoryDecider;
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('none'), cand('rev', { sourcePrMergedPastWindow: true, sourcePrReverted: true })] });
    const r = await runMemoryLifecycle({ deps, decider });
    expect(calls.promote).toHaveLength(0);
    expect(r.held).toBe(2);
  });

  it('a confident veto defers a rule-promoted candidate one cycle: tagged, held, not promoted', async () => {
    const { decider } = vetoing(['vetoed']);
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [
      cand('vetoed', { sourcePrMergedPastWindow: true }),
      cand('kept', { corroborated: true }),
    ] });
    const r = await runMemoryLifecycle({ deps, decider });
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['kept'] }]);
    expect(calls.deferred).toEqual([{ teamId: TEAM, ids: ['vetoed'] }]);
    expect(r).toMatchObject({ promoted: 1, deferred: 1, held: 1 });
  });

  it('the next cycle does not veto again: a deferred candidate is asked in shadow and promotes by the rule', async () => {
    const { decider, asked } = vetoing(['vetoed']);
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('vetoed', { sourcePrMergedPastWindow: true }, TEAM, true)] });
    const r = await runMemoryLifecycle({ deps, decider });
    expect(asked.flat()).toEqual([expect.objectContaining({ memoryId: 'vetoed', live: false, rule: 'promote' })]);
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['vetoed'] }]);
    expect(calls.deferred).toHaveLength(0);
    expect(r).toMatchObject({ promoted: 1, deferred: 0 });
  });

  it('no decider or a failing one: the rule alone decides (fails open)', async () => {
    const boom = { judgePromote: async () => { throw new Error('down'); } } as unknown as MemoryDecider;
    for (const decider of [null, boom]) {
      const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('m', { sourcePrMergedPastWindow: true })] });
      const r = await runMemoryLifecycle({ deps, decider });
      expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['m'] }]);
      expect(r.errors).toBe(0);
    }
  });

  it('rollback: with the veto off, every item is a challenger and a veto is ignored', async () => {
    const { decider, asked } = vetoing(['m']);
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [cand('m', { sourcePrMergedPastWindow: true })] });
    await runMemoryLifecycle({ deps, decider, promoteVetoLive: false });
    expect(asked.flat().every(i => !i.live)).toBe(true);
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['m'] }]);
    expect(calls.deferred).toHaveLength(0);
  });

  it('keep reader: a not-durable candidate is held, unless an agent pulled it', async () => {
    const { decider, asked } = vetoing();
    const { deps, calls } = fakeDeps({ findPromotionCandidates: async () => [
      cand('summary', { sourcePrMergedPastWindow: true, notDurable: true }),
      cand('pulled', { sourcePrMergedPastWindow: true, notDurable: true, pulled: true }),
    ] });
    const r = await runMemoryLifecycle({ deps, decider });
    expect(calls.promote).toEqual([{ teamId: TEAM, ids: ['pulled'] }]);
    expect(r.held).toBe(1);
    expect(asked.flat().find(i => i.memoryId === 'summary')).toMatchObject({ rule: 'hold:not_durable', live: false });
    // Held, it is left to the normal unpulled-candidate expiry.
    expect(calls.expire).toHaveLength(1);
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
    expect(r.extracted).toEqual({ failedTasks: MEMORY_EXTRACT_MAX_PER_RUN - 1, reviews: 1, duplicates: 0, skipped: 0, failed: 0 });
  });

  it('counts outcomes, and records every settled attempt (not a failed write, which is retried)', async () => {
    const outs = ['duplicate', 'failed', 'written'] as const;
    let i = 0;
    const { deps, calls } = fakeDeps({
      flaggedWorkspaces: async () => [{ id: WS, teamId: TEAM, project: 'p' }],
      findFailedTasks: async () => [
        ...outs.map((_, k) => ({ id: `t${k}`, workspaceId: WS, title: 'x', summary: 's', error: null, files: [] })),
        { id: 'empty', workspaceId: WS, title: 'x', summary: null, error: null, files: [] },
      ],
      writeCandidate: async () => outs[i++],
    });
    const r = await runMemoryLifecycle({ deps });
    expect(r.extracted).toEqual({ failedTasks: 1, reviews: 0, duplicates: 1, skipped: 1, failed: 1 });
    expect(calls.attempts).toEqual([
      { workspaceId: WS, sourceKind: 'failed_task', sourceId: 't0', outcome: 'duplicate' },
      { workspaceId: WS, sourceKind: 'failed_task', sourceId: 't2', outcome: 'written' },
      { workspaceId: WS, sourceKind: 'failed_task', sourceId: 'empty', outcome: 'skipped' },
    ]);
  });

  it('applies deferred supersedes for the rows it promoted, per team', async () => {
    const { deps, calls } = fakeDeps({
      findPromotionCandidates: async () => [cand('merged', { sourcePrMergedPastWindow: true }), cand('none')],
      promote: async (_t, ids) => ids,
      applyPendingSupersedes: async (teamId, ids) => { calls.applied.push({ teamId, ids }); return 2; },
    });
    const r = await runMemoryLifecycle({ deps });
    expect(calls.applied).toEqual([{ teamId: TEAM, ids: ['merged'] }]);
    expect(r.pendingSuperseded).toBe(2);
  });

  it('one deadline covers the pass: checked between items, the rest skipped, reported as timedOut', async () => {
    let t = 0;
    const ws = { id: WS, teamId: TEAM, project: 'p' };
    const { deps, calls } = fakeDeps({
      flaggedWorkspaces: async () => [ws],
      findFailedTasks: async () => Array.from({ length: 5 }, (_, k) => ({ id: `t${k}`, workspaceId: WS, title: 'x', summary: 's', error: 'e', files: [] })),
      // Each write costs 10s of the clock.
      writeCandidate: async (w, c, taskId) => { t += 10_000; calls.written.push({ w, c, taskId }); return 'written'; },
      expire: async () => { throw new Error('must not run past the deadline'); },
    });
    const r = await runMemoryLifecycle({ deps, now: () => t, deadlineMs: 20_000 });
    expect(r.timedOut).toBe(true);
    expect(calls.written).toHaveLength(2);
    expect(r.errors).toBe(0);
    expect(r.expired).toBe(0);
  });

  it('abandons a call that hangs past the deadline instead of waiting on it', async () => {
    const { deps } = fakeDeps({
      findPromotionCandidates: () => new Promise(() => {}),
    });
    const started = Date.now();
    const r = await runMemoryLifecycle({ deps, deadlineMs: 50 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
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

describe('cron step budgets', () => {
  it('the lifecycle gets its own cap, or what the cron has left minus a reserve, whichever is less', () => {
    expect(lifecycleDeadlineMs(0, 60_000)).toBe(MEMORY_LIFECYCLE_DEADLINE_MS);
    expect(lifecycleDeadlineMs(40_000, 60_000)).toBe(15_000);
    expect(lifecycleDeadlineMs(58_000, 60_000)).toBe(0);
    expect(cronStepBudgetMs(15_000, 10_000, 60_000)).toBe(15_000);
    expect(cronStepBudgetMs(15_000, 45_000, 60_000)).toBe(10_000);
    expect(cronStepBudgetMs(15_000, -5, 60_000)).toBe(15_000);
  });
});
