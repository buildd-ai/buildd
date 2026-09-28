/**
 * The memory lifecycle pass: promotion, expiry, re-verify flags and
 * candidate extraction (docs/design/memory-done-right.md, "Write: candidates,
 * then promotion"). The rules are in ./memory-candidates; this is the SQL and
 * the orchestration.
 *
 * Per run, each step bounded:
 *
 * 1. **Extract** (flagged workspaces only): failed tasks (error + last
 *    summary) and changes-requested PR reviews become candidates, written
 *    through `learn` in dedupe-only mode, so a near-duplicate of anything
 *    already recorded writes nothing and replaces nothing. Review text is
 *    external and never auto-promotes.
 * 2. **Promote**: a candidate becomes active when its source task's PR merged
 *    at least 72h ago and was not reverted inside that window, or when a
 *    different task's near-duplicate `learn` in the same project was folded
 *    into it. External content never promotes. The `promote` Jev decision is
 *    asked in shadow over the same evidence and only logged.
 * 3. **Expire**: a candidate older than 30 days with no pull and no `used`
 *    outcome in memory_uses becomes expired. Nothing is deleted.
 * 4. **Re-verify** (flagged workspaces only): a merged PR touching a memory's
 *    anchored files flags it (`reverify_flagged_at`). Never a demotion.
 *
 * Every read and write stays inside the memory's own team and project: the
 * promotion evidence joins only same-team, same-project rows, extraction
 * writes under the workspace's own project key, and a re-verify flag is set
 * only on rows under the key of the workspace whose PR merged.
 *
 * Rides the feedback-digest cron (with the index reconcile pass); no schedule
 * of its own.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  decidePromotion,
  failedTaskCandidate,
  reviewCandidate,
  MEMORY_CANDIDATE_EXPIRY_DAYS,
  MEMORY_EXPIRE_MAX_PER_RUN,
  MEMORY_EXTRACT_MAX_PER_RUN,
  MEMORY_EXTRACT_WINDOW_HOURS,
  MEMORY_PROMOTE_MAX_PER_RUN,
  MEMORY_PROMOTE_SHADOW_MAX_PER_RUN,
  MEMORY_REVERIFY_MAX_JOBS_PER_RUN,
  MEMORY_CANDIDATE_FLAG,
  PROMOTION_REVERT_WINDOW_HOURS,
  type ExtractedCandidate,
  type PromotionEvidence,
} from './memory-candidates';
import { memoryFilesOverlapSql } from './memory-file-scope-sql';
import type { MemoryDecider, PromoteShadowItem } from './memory-decisions';
import type { KnowledgeStore } from './knowledge-store/types';

const clampInt = (n: number, max: number): number => {
  const v = Math.floor(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, max);
};

/**
 * A parenthesised list of uuid parameters, one bound value each, for
 * `col IN <list>`. Empty renders `(NULL::uuid)`, which matches nothing.
 */
function uuidList(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`(NULL::uuid)`;
  return sql`(${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`;
}

const UUID_TEXT_RE = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/**
 * The task a memory row's episode belongs to, as a uuid (or NULL): the
 * recorded source id for learn / failed_task rows, else the task of the
 * worker named in `source` ("worker:<id>", which every learn has written).
 * Casts are guarded, so a malformed value is NULL, never an error.
 */
export function memorySourceTaskSql(alias: 'm' | 'm2' | 'memories'): SQL {
  const a = sql.raw(alias);
  return sql`COALESCE(
    CASE WHEN ${a}.source_kind IN ('learn', 'failed_task') AND ${a}.source_id ~ ${sql.raw(UUID_TEXT_RE)}
         THEN ${a}.source_id::uuid END,
    (SELECT sw.task_id FROM workers sw
      WHERE ${a}.source LIKE 'worker:%'
        AND substr(${a}.source, 8) ~ ${sql.raw(UUID_TEXT_RE)}
        AND sw.id = substr(${a}.source, 8)::uuid
      LIMIT 1)
  )`;
}

// ── Promotion ────────────────────────────────────────────────────────────────

/**
 * Candidates with their promotion evidence, oldest first.
 *
 * - `merged_past_window`: the source task has a merged PR, merged at least the
 *   revert window ago.
 * - `reverted`: inside that window, a merged buildd task titled as a revert
 *   of it, or a later merged PR in the same workspace with exactly the same
 *   file list (what a revert looks like in the ingest log), landed.
 * - `corroborated`: a row in the same team and project, from a different task,
 *   not external, was superseded by this candidate (the learn near-duplicate
 *   path folds a repeat of the same lesson into the newer row).
 */
export function promotionCandidatesQuery(limit: number): SQL {
  const window = sql`make_interval(hours => ${PROMOTION_REVERT_WINDOW_HOURS})`;
  return sql`
    SELECT m.id, m.team_id, m.project, m.type, m.title, m.content, m.external, m.source_kind,
           src.task_id AS source_task_id,
           (pr.merged_at IS NOT NULL AND pr.merged_at <= now() - ${window}) AS merged_past_window,
           (pr.merged_at IS NOT NULL AND (
             EXISTS (
               SELECT 1 FROM workers rw JOIN tasks rt ON rt.id = rw.task_id
               WHERE rw.workspace_id = pr.workspace_id
                 AND rw.merged_at > pr.merged_at
                 AND rw.merged_at <= pr.merged_at + ${window}
                 AND rt.title ILIKE 'revert%'
                 AND (strpos(rt.title, '#' || pr.pr_number::text) > 0
                      OR strpos(lower(rt.title), lower(pr.title)) > 0)
             )
             OR EXISTS (
               SELECT 1 FROM knowledge_ingest_jobs js
               JOIN knowledge_ingest_jobs jr
                 ON jr.workspace_id = js.workspace_id
                AND jr.trigger = 'pr_merged'
                AND jr.pr_number IS DISTINCT FROM js.pr_number
                AND jr.created_at > js.created_at
                AND jr.created_at <= js.created_at + ${window}
                AND jr.changed_files @> js.changed_files
                AND js.changed_files @> jr.changed_files
               WHERE js.workspace_id = pr.workspace_id
                 AND js.pr_number = pr.pr_number
                 AND js.trigger = 'pr_merged'
                 AND jsonb_array_length(js.changed_files) > 0
             )
           )) AS reverted,
           (m.source_kind = 'learn' AND src.task_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM memories m2
             WHERE m2.team_id = m.team_id
               AND m2.project = m.project
               AND m2.superseded_by = m.id
               AND m2.external = false
               AND (m2.source_kind IS NULL OR m2.source_kind = 'learn')
               AND ${memorySourceTaskSql('m2')} IS NOT NULL
               AND ${memorySourceTaskSql('m2')} <> src.task_id
           )) AS corroborated
    FROM memories m
    LEFT JOIN LATERAL (SELECT ${memorySourceTaskSql('m')} AS task_id) src ON true
    LEFT JOIN LATERAL (
      SELECT w.merged_at, w.pr_number, w.workspace_id, t.title
      FROM workers w JOIN tasks t ON t.id = w.task_id
      WHERE w.task_id = src.task_id AND w.merged_at IS NOT NULL
      ORDER BY w.merged_at DESC
      LIMIT 1
    ) pr ON true
    WHERE m.state = 'candidate'
      AND m.superseded_by IS NULL
      AND m.project IS NOT NULL
    ORDER BY m.created_at ASC
    LIMIT ${clampInt(limit, MEMORY_PROMOTE_MAX_PER_RUN)}
  `;
}

/**
 * Promote these candidates. The hard floors are re-checked in the UPDATE
 * itself: only a current, non-external candidate of this team moves.
 */
export function promoteCandidatesSql(teamId: string, ids: readonly string[]): SQL {
  return sql`
    UPDATE memories
    SET state = 'active', valid_from = now(), updated_at = now()
    WHERE team_id = ${teamId}
      AND id IN ${uuidList(ids)}
      AND state = 'candidate'
      AND external = false
      AND superseded_by IS NULL
    RETURNING id
  `;
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Expire unpromoted candidates older than `days` that no agent pulled and no
 * task used (per memory_uses). A state change, never a delete.
 */
export function expireCandidatesSql(days: number, limit: number): SQL {
  return sql`
    UPDATE memories
    SET state = 'expired', updated_at = now()
    WHERE state = 'candidate'
      AND id IN (
        SELECT m.id FROM memories m
        WHERE m.state = 'candidate'
          AND m.created_at < now() - make_interval(days => ${clampInt(days, 3650)})
          AND NOT EXISTS (
            SELECT 1 FROM memory_uses u
            WHERE u.team_id = m.team_id
              AND u.memory_id = m.id::text
              AND (u.via = 'pull' OR u.outcome = 'used')
          )
        ORDER BY m.created_at ASC
        LIMIT ${clampInt(limit, MEMORY_EXPIRE_MAX_PER_RUN)}
      )
    RETURNING id
  `;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Workspaces with the flag on, never a sensitive one. */
export function flaggedWorkspacesQuery(): SQL {
  return sql`
    SELECT id, team_id FROM workspaces
    WHERE git_config -> ${MEMORY_CANDIDATE_FLAG} = 'true'::jsonb
      AND data_class IS DISTINCT FROM 'sensitive'
  `;
}

/**
 * Recently failed tasks in these workspaces that have not been extracted yet,
 * with their latest worker's error and the task's last summary.
 */
export function failedTasksForExtractionQuery(workspaceIds: readonly string[], windowHours: number, limit: number): SQL {
  return sql`
    SELECT t.id, t.workspace_id, t.title, t.result->>'summary' AS summary, lw.error, t.path_manifest
    FROM tasks t
    LEFT JOIN LATERAL (
      SELECT w.error FROM workers w WHERE w.task_id = t.id ORDER BY w.created_at DESC LIMIT 1
    ) lw ON true
    WHERE t.workspace_id IN ${uuidList(workspaceIds)}
      AND t.status = 'failed'
      AND t.updated_at > now() - make_interval(hours => ${clampInt(windowHours, 24 * 30)})
      AND NOT EXISTS (
        SELECT 1 FROM memories m WHERE m.source_kind = 'failed_task' AND m.source_id = t.id::text
      )
    ORDER BY t.updated_at DESC
    LIMIT ${clampInt(limit, MEMORY_EXTRACT_MAX_PER_RUN)}
  `;
}

/**
 * Recent changes-requested reviews on these workspaces' own task PRs, not yet
 * extracted, with the paths the same PR's inline comments name.
 */
export function changesRequestedReviewsQuery(workspaceIds: readonly string[], windowHours: number, limit: number): SQL {
  return sql`
    SELECT r.id, r.workspace_id, r.task_id, r.pr_number, r.body,
           ARRAY(
             SELECT DISTINCT c.path FROM review_feedback c
             WHERE c.workspace_id = r.workspace_id AND c.pr_number = r.pr_number
               AND c.kind = 'inline_comment' AND c.path IS NOT NULL
             LIMIT 20
           ) AS files
    FROM review_feedback r
    WHERE r.workspace_id IN ${uuidList(workspaceIds)}
      AND r.kind = 'review'
      AND r.state = 'changes_requested'
      AND r.task_id IS NOT NULL
      AND r.created_at > now() - make_interval(hours => ${clampInt(windowHours, 24 * 30)})
      AND NOT EXISTS (
        SELECT 1 FROM memories m WHERE m.source_kind = 'review' AND m.source_id = r.id::text
      )
    ORDER BY r.created_at DESC
    LIMIT ${clampInt(limit, MEMORY_EXTRACT_MAX_PER_RUN)}
  `;
}

// ── Re-verify ────────────────────────────────────────────────────────────────

/** Recently finished merged-PR ingest jobs in these workspaces, with their file lists. */
export function mergedPrJobsQuery(workspaceIds: readonly string[], windowHours: number, limit: number): SQL {
  return sql`
    SELECT j.id, j.workspace_id, j.pr_number, j.changed_files, j.created_at
    FROM knowledge_ingest_jobs j
    WHERE j.workspace_id IN ${uuidList(workspaceIds)}
      AND j.trigger = 'pr_merged'
      AND j.status = 'done'
      AND j.pr_number IS NOT NULL
      AND j.finished_at > now() - make_interval(hours => ${clampInt(windowHours, 24 * 30)})
    ORDER BY j.finished_at DESC
    LIMIT ${clampInt(limit, MEMORY_REVERIFY_MAX_JOBS_PER_RUN)}
  `;
}

export interface ReverifyTarget {
  teamId: string;
  project: string;
  workspaceId: string;
  prNumber: number;
  files: readonly string[];
  mergedAt: Date;
}

/**
 * Flag current memories in one team + project whose files overlap a merged
 * PR's, written before it merged. The memory's own task's PR is not a reason
 * to re-verify it. Null when the PR touched no files.
 */
export function flagReverifySql(t: ReverifyTarget): SQL | null {
  const overlap = memoryFilesOverlapSql(t.files);
  if (!overlap) return null;
  return sql`
    UPDATE memories
    SET reverify_flagged_at = now(), reverify_ref = ${`pr:${t.prNumber}`}
    WHERE team_id = ${t.teamId}
      AND project = ${t.project}
      AND superseded_by IS NULL
      AND state IN ('active', 'candidate')
      AND reverify_flagged_at IS NULL
      AND created_at < ${t.mergedAt.toISOString()}::timestamptz
      AND ${overlap}
      AND NOT EXISTS (
        SELECT 1 FROM workers ow
        WHERE ow.workspace_id = ${t.workspaceId}
          AND ow.pr_number = ${t.prNumber}
          AND ow.task_id IS NOT NULL
          AND ow.task_id = ${memorySourceTaskSql('memories')}
      )
    RETURNING id
  `;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface FlaggedWorkspace { id: string; teamId: string; project: string }

export interface PromotionCandidateRow {
  id: string;
  teamId: string;
  project: string | null;
  type: string;
  title: string;
  content: string;
  sourceKind: string | null;
  evidence: PromotionEvidence;
}

export interface LifecycleDeps {
  flaggedWorkspaces(): Promise<FlaggedWorkspace[]>;
  findPromotionCandidates(limit: number): Promise<PromotionCandidateRow[]>;
  promote(teamId: string, ids: string[]): Promise<string[]>;
  expire(days: number, limit: number): Promise<number>;
  findFailedTasks(workspaceIds: string[], windowHours: number, limit: number): Promise<Array<{
    id: string; workspaceId: string; title: string; summary: string | null; error: string | null; files: string[];
  }>>;
  findChangesRequestedReviews(workspaceIds: string[], windowHours: number, limit: number): Promise<Array<{
    id: string; workspaceId: string; taskId: string | null; prNumber: number; body: string; files: string[];
  }>>;
  /** Write one extracted candidate via learn (dedupe-only). */
  writeCandidate(ws: FlaggedWorkspace, c: ExtractedCandidate, taskId: string | null): Promise<'written' | 'duplicate' | 'failed'>;
  findMergedPrJobs(workspaceIds: string[], windowHours: number, limit: number): Promise<Array<{
    workspaceId: string; prNumber: number; files: string[]; mergedAt: Date;
  }>>;
  flagReverify(t: ReverifyTarget): Promise<number>;
}

export interface LifecycleResult {
  extracted: { failedTasks: number; reviews: number; duplicates: number; failed: number };
  promoted: number;
  held: number;
  shadowed: number;
  expired: number;
  reverifyFlagged: number;
  errors: number;
}

async function getDb() {
  const { db } = await import('./db');
  return db;
}

async function rowsOf<T>(q: SQL): Promise<T[]> {
  const db = await getDb();
  const res = await db.execute(q);
  return res.rows as T[];
}

function dbDeps(knowledgeStore: KnowledgeStore | null): LifecycleDeps {
  return {
    async flaggedWorkspaces() {
      const rows = await rowsOf<{ id: string; team_id: string }>(flaggedWorkspacesQuery());
      const { resolveMemoryProjectKey } = await import('./memory-scope');
      const out: FlaggedWorkspace[] = [];
      for (const r of rows) {
        // The same key every memory read and write of this workspace uses;
        // null (sensitive, shared with a sensitive key, none) gets nothing.
        const project = await resolveMemoryProjectKey(r.id);
        if (project) out.push({ id: r.id, teamId: r.team_id, project });
      }
      return out;
    },
    async findPromotionCandidates(limit) {
      const rows = await rowsOf<{
        id: string; team_id: string; project: string | null; type: string; title: string; content: string;
        external: boolean; source_kind: string | null; merged_past_window: boolean | null; reverted: boolean | null; corroborated: boolean | null;
      }>(promotionCandidatesQuery(limit));
      return rows.map(r => ({
        id: r.id, teamId: r.team_id, project: r.project, type: r.type, title: r.title, content: r.content,
        sourceKind: r.source_kind,
        evidence: {
          external: r.external === true,
          sourcePrMergedPastWindow: r.merged_past_window === true,
          sourcePrReverted: r.reverted === true,
          corroborated: r.corroborated === true,
        },
      }));
    },
    async promote(teamId, ids) {
      if (ids.length === 0) return [];
      const rows = await rowsOf<{ id: string }>(promoteCandidatesSql(teamId, ids));
      return rows.map(r => r.id);
    },
    async expire(days, limit) {
      return (await rowsOf<{ id: string }>(expireCandidatesSql(days, limit))).length;
    },
    async findFailedTasks(workspaceIds, windowHours, limit) {
      if (workspaceIds.length === 0) return [];
      const rows = await rowsOf<{
        id: string; workspace_id: string; title: string; summary: string | null; error: string | null; path_manifest: unknown;
      }>(failedTasksForExtractionQuery(workspaceIds, windowHours, limit));
      return rows.map(r => ({
        id: r.id, workspaceId: r.workspace_id, title: r.title, summary: r.summary, error: r.error,
        files: Array.isArray(r.path_manifest) ? r.path_manifest.filter((p): p is string => typeof p === 'string') : [],
      }));
    },
    async findChangesRequestedReviews(workspaceIds, windowHours, limit) {
      if (workspaceIds.length === 0) return [];
      const rows = await rowsOf<{
        id: string; workspace_id: string; task_id: string | null; pr_number: number; body: string; files: string[] | null;
      }>(changesRequestedReviewsQuery(workspaceIds, windowHours, limit));
      return rows.map(r => ({
        id: r.id, workspaceId: r.workspace_id, taskId: r.task_id, prNumber: Number(r.pr_number), body: r.body, files: r.files ?? [],
      }));
    },
    async writeCandidate(ws, c, taskId) {
      const { handleLearnAction } = await import('./mcp-tools');
      const { MemoryStore } = await import('./memory-store');
      try {
        const out = await handleLearnAction(new MemoryStore(ws.teamId), {
          type: c.type, title: c.title, content: c.content, ...(c.files.length ? { files: c.files } : {}),
        }, {
          project: ws.project,
          teamId: ws.teamId,
          workspaceId: ws.id,
          ...(taskId ? { taskId } : {}),
          knowledgeStore: knowledgeStore ?? undefined,
          memoryCandidateWrites: true,
          memoryProvenance: c.provenance,
          memoryDedupeOnly: true,
        });
        if (out.isError) return 'failed';
        const txt = out.content.map(p => p.text).join('\n');
        return txt.startsWith('Memory saved:') ? 'written' : 'duplicate';
      } catch {
        return 'failed';
      }
    },
    async findMergedPrJobs(workspaceIds, windowHours, limit) {
      if (workspaceIds.length === 0) return [];
      const rows = await rowsOf<{ workspace_id: string; pr_number: number; changed_files: unknown; created_at: string | Date }>(
        mergedPrJobsQuery(workspaceIds, windowHours, limit),
      );
      return rows.map(r => ({
        workspaceId: r.workspace_id,
        prNumber: Number(r.pr_number),
        files: Array.isArray(r.changed_files) ? r.changed_files.filter((p): p is string => typeof p === 'string') : [],
        mergedAt: new Date(r.created_at),
      }));
    },
    async flagReverify(t) {
      const q = flagReverifySql(t);
      if (!q) return 0;
      return (await rowsOf<{ id: string }>(q)).length;
    },
  };
}

/**
 * Run one bounded lifecycle pass. Never throws: a failed step is counted in
 * `errors` and the other steps still run.
 */
export async function runMemoryLifecycle(opts: {
  knowledgeStore?: KnowledgeStore | null;
  decider?: MemoryDecider | null;
  deps?: LifecycleDeps;
} = {}): Promise<LifecycleResult> {
  const deps = opts.deps ?? dbDeps(opts.knowledgeStore ?? null);
  const result: LifecycleResult = {
    extracted: { failedTasks: 0, reviews: 0, duplicates: 0, failed: 0 },
    promoted: 0, held: 0, shadowed: 0, expired: 0, reverifyFlagged: 0, errors: 0,
  };

  let flagged: FlaggedWorkspace[] = [];
  try {
    flagged = await deps.flaggedWorkspaces();
  } catch (err) {
    result.errors++;
    console.warn('[memory-lifecycle] flagged workspaces lookup failed', err);
  }
  const byId = new Map(flagged.map(w => [w.id, w]));
  const wsIds = flagged.map(w => w.id);

  // 1. Extract. One budget across both sources, failed tasks first.
  if (wsIds.length > 0) {
    try {
      let budget = MEMORY_EXTRACT_MAX_PER_RUN;
      const tally = async (ws: FlaggedWorkspace | undefined, c: ExtractedCandidate | null, taskId: string | null, kind: 'failedTasks' | 'reviews') => {
        if (!ws || !c || budget <= 0) return;
        budget--;
        const out = await deps.writeCandidate(ws, c, taskId);
        if (out === 'written') result.extracted[kind]++;
        else if (out === 'duplicate') result.extracted.duplicates++;
        else result.extracted.failed++;
      };
      const failed = await deps.findFailedTasks(wsIds, MEMORY_EXTRACT_WINDOW_HOURS, budget);
      for (const t of failed) {
        await tally(byId.get(t.workspaceId), failedTaskCandidate({ taskId: t.id, title: t.title, error: t.error, summary: t.summary, files: t.files }), t.id, 'failedTasks');
      }
      if (budget > 0) {
        const reviews = await deps.findChangesRequestedReviews(wsIds, MEMORY_EXTRACT_WINDOW_HOURS, budget);
        for (const r of reviews) {
          await tally(byId.get(r.workspaceId), reviewCandidate({ reviewId: r.id, prNumber: r.prNumber, body: r.body, files: r.files }), r.taskId, 'reviews');
        }
      }
    } catch (err) {
      result.errors++;
      console.warn('[memory-lifecycle] extraction failed', err);
    }
  }

  // 2. Promote, deterministic rule; Jev in shadow.
  try {
    const candidates = await deps.findPromotionCandidates(MEMORY_PROMOTE_MAX_PER_RUN);
    const toPromote = new Map<string, string[]>();
    const shadow = new Map<string, PromoteShadowItem[]>();
    let shadowBudget = MEMORY_PROMOTE_SHADOW_MAX_PER_RUN;
    for (const c of candidates) {
      const verdict = decidePromotion(c.evidence);
      if (verdict.promote) {
        const list = toPromote.get(c.teamId) ?? [];
        list.push(c.id);
        toPromote.set(c.teamId, list);
      } else {
        result.held++;
      }
      // External content is never asked about: nothing Jev says could promote it.
      if (!c.evidence.external && shadowBudget > 0) {
        shadowBudget--;
        const items = shadow.get(c.teamId) ?? [];
        items.push({
          memoryId: c.id, title: c.title, content: c.content, type: c.type,
          evidence: { sourceKind: c.sourceKind, ...c.evidence },
          rule: verdict.promote ? 'promote' : `hold:${verdict.reason}`,
        });
        shadow.set(c.teamId, items);
      }
    }
    for (const [teamId, ids] of toPromote) {
      result.promoted += (await deps.promote(teamId, ids)).length;
    }
    if (opts.decider?.shadowPromote) {
      for (const [teamId, items] of shadow) {
        await opts.decider.shadowPromote({ scope: { teamId }, items }).catch(() => {});
        result.shadowed += items.length;
      }
    }
  } catch (err) {
    result.errors++;
    console.warn('[memory-lifecycle] promotion failed', err);
  }

  // 3. Expire.
  try {
    result.expired = await deps.expire(MEMORY_CANDIDATE_EXPIRY_DAYS, MEMORY_EXPIRE_MAX_PER_RUN);
  } catch (err) {
    result.errors++;
    console.warn('[memory-lifecycle] expiry failed', err);
  }

  // 4. Re-verify flags.
  if (wsIds.length > 0) {
    try {
      const jobs = await deps.findMergedPrJobs(wsIds, MEMORY_EXTRACT_WINDOW_HOURS, MEMORY_REVERIFY_MAX_JOBS_PER_RUN);
      for (const j of jobs) {
        const ws = byId.get(j.workspaceId);
        if (!ws || j.files.length === 0) continue;
        result.reverifyFlagged += await deps.flagReverify({
          teamId: ws.teamId, project: ws.project, workspaceId: ws.id, prNumber: j.prNumber, files: j.files, mergedAt: j.mergedAt,
        });
      }
    } catch (err) {
      result.errors++;
      console.warn('[memory-lifecycle] re-verify failed', err);
    }
  }

  return result;
}
