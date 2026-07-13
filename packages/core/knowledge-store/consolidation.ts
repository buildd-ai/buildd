import { sql } from 'drizzle-orm';
import type { Corpus } from './types';
import { HALF_LIFE_DAYS } from './recency-authority';

/**
 * Phase C (C2): deterministic consolidation support queries.
 *
 * These helpers do NO LLM work — they surface candidates for the weekly
 * consolidation agent (spec §5), which judges and acts via the
 * `consolidate_knowledge` MCP action. Nothing here deletes rows: archiving is
 * `is_current = false`, recoverable via `query(..., { history: true })`.
 *
 * Namespaces are `${scopeId}:${corpus}` (see buildNamespace); a namespace holds
 * exactly one corpus, so "corpora" selection happens by choosing namespaces —
 * the MCP layer resolves corpus → namespace per the caller's team/workspace.
 */

// Lazy DB import — avoids hitting DATABASE_URL during build/test
async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

const MAX_PAIR_LIMIT = 200;
const MAX_CANDIDATE_LIMIT = 2000;
const MAX_DECAYED_LIMIT = 500;

function toList(namespaces: string | string[]): string[] {
  return (Array.isArray(namespaces) ? namespaces : [namespaces]).filter(Boolean);
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

// ── Near-duplicate detection ──────────────────────────────────────────────────

export interface NearDuplicatePair {
  namespace: string;
  sourceIdA: string;
  sourceIdB: string;
  /** Embedding cosine similarity (1 = identical direction). */
  similarity: number;
  previewA: string;
  previewB: string;
  sourceTsA: Date | null;
  sourceTsB: Date | null;
  hitCountA: number;
  hitCountB: number;
}

export interface FindNearDuplicatesOptions {
  /** Cosine similarity floor (exclusive). Default 0.92 per spec §5. */
  threshold?: number;
  /** Max pairs returned. Default 50, hard cap 200. */
  limit?: number;
  /**
   * Max chunks entering the self-join, most recent first. Default 500, hard
   * cap 2000 — bounds the comparison to candidateLimit²/2 so a big namespace
   * can't melt the DB.
   */
  candidateLimit?: number;
}

/**
 * Find pairs of `is_current` chunks in the SAME namespace whose embedding
 * cosine similarity exceeds the threshold. Pairs are deduped via `a.id < b.id`
 * and ordered by similarity DESC.
 */
export async function findNearDuplicates(
  namespaces: string | string[],
  opts: FindNearDuplicatesOptions = {},
): Promise<NearDuplicatePair[]> {
  const nsList = toList(namespaces);
  if (nsList.length === 0) return [];

  const threshold = opts.threshold ?? 0.92;
  const limit = Math.min(opts.limit ?? 50, MAX_PAIR_LIMIT);
  const candidateLimit = Math.min(opts.candidateLimit ?? 500, MAX_CANDIDATE_LIMIT);

  const db = await getDb();
  const nsIn = sql.join(nsList.map(ns => sql`${ns}`), sql`, `);

  const res = await db.execute(sql`
    WITH candidates AS (
      SELECT id, source_id, namespace, embedding, content, source_ts, hit_count
      FROM knowledge_chunks
      WHERE namespace IN (${nsIn})
        AND is_current = true
        AND embedding IS NOT NULL
      ORDER BY source_ts DESC NULLS LAST
      LIMIT ${candidateLimit}
    )
    SELECT a.namespace,
           a.source_id AS source_id_a,
           b.source_id AS source_id_b,
           1 - (a.embedding <=> b.embedding) AS similarity,
           left(a.content, 240) AS preview_a,
           left(b.content, 240) AS preview_b,
           a.source_ts AS source_ts_a,
           b.source_ts AS source_ts_b,
           a.hit_count AS hit_count_a,
           b.hit_count AS hit_count_b
    FROM candidates a
    JOIN candidates b
      ON a.namespace = b.namespace
     AND a.id < b.id
    WHERE 1 - (a.embedding <=> b.embedding) > ${threshold}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  return (res.rows as Array<Record<string, unknown>>).map(r => ({
    namespace: String(r.namespace),
    sourceIdA: String(r.source_id_a),
    sourceIdB: String(r.source_id_b),
    similarity: Number(r.similarity),
    previewA: String(r.preview_a ?? ''),
    previewB: String(r.preview_b ?? ''),
    sourceTsA: toDate(r.source_ts_a),
    sourceTsB: toDate(r.source_ts_b),
    hitCountA: Number(r.hit_count_a ?? 0),
    hitCountB: Number(r.hit_count_b ?? 0),
  }));
}

// ── Decayed-unused detection ──────────────────────────────────────────────────

export interface DecayedChunk {
  namespace: string;
  sourceId: string;
  corpus: Corpus;
  sourceTs: Date | null;
  hitCount: number;
  preview: string;
}

export interface FindDecayedUnusedOptions {
  /** Age threshold as a multiple of the corpus half-life. Default 6 per spec §5. */
  halfLifeMultiple?: number;
  /** Max rows returned. Default 200, hard cap 500. */
  limit?: number;
  /** Clock override for tests. */
  now?: Date;
}

/**
 * Find `is_current` chunks older than `halfLifeMultiple` × their corpus
 * half-life (per HALF_LIFE_DAYS) that have never been returned by a query
 * (`hit_count = 0`). Chunks without a source_ts are never flagged —
 * age is unknowable, so stay conservative.
 *
 * The corpus (and thus half-life) is derived from each namespace's
 * `:corpus` segment; namespaces with an unknown corpus are skipped.
 */
export async function findDecayedUnused(
  namespaces: string | string[],
  opts: FindDecayedUnusedOptions = {},
): Promise<DecayedChunk[]> {
  const multiple = opts.halfLifeMultiple ?? 6;
  const limit = Math.min(opts.limit ?? 200, MAX_DECAYED_LIMIT);
  const now = opts.now ?? new Date();

  const scoped = toList(namespaces)
    .map(ns => ({ ns, corpus: ns.split(':')[1] as Corpus | undefined }))
    .filter((s): s is { ns: string; corpus: Corpus } =>
      s.corpus !== undefined && s.corpus in HALF_LIFE_DAYS);
  if (scoped.length === 0) return [];

  const db = await getDb();
  const cutoffClauses = sql.join(
    scoped.map(({ ns, corpus }) => {
      const cutoff = new Date(now.getTime() - multiple * HALF_LIFE_DAYS[corpus] * 24 * 60 * 60 * 1000);
      return sql`(namespace = ${ns} AND source_ts < ${cutoff.toISOString()})`;
    }),
    sql` OR `,
  );

  const res = await db.execute(sql`
    SELECT namespace, source_id, corpus, source_ts, hit_count,
           left(content, 240) AS preview
    FROM knowledge_chunks
    WHERE is_current = true
      AND hit_count = 0
      AND source_ts IS NOT NULL
      AND (${cutoffClauses})
    ORDER BY source_ts ASC
    LIMIT ${limit}
  `);

  return (res.rows as Array<Record<string, unknown>>).map(r => ({
    namespace: String(r.namespace),
    sourceId: String(r.source_id),
    corpus: r.corpus as Corpus,
    sourceTs: toDate(r.source_ts),
    hitCount: Number(r.hit_count ?? 0),
    preview: String(r.preview ?? ''),
  }));
}

// ── Archiving ─────────────────────────────────────────────────────────────────

export interface ArchiveResult {
  archived: number;
  sourceIds: string[];
}

/**
 * Archive chunks: flip `is_current = false` with an audit marker in
 * `superseded_by`. NOTHING is deleted — archived chunks remain recoverable via
 * `query(..., { history: true })`. Atomic UPDATE…WHERE (no transaction —
 * neon-http constraint); only rows that were still current are counted.
 */
export async function archiveChunks(
  namespace: string,
  sourceIds: string[],
  opts: { reason?: string } = {},
): Promise<ArchiveResult> {
  const ids = Array.from(new Set(sourceIds.filter(Boolean)));
  if (ids.length === 0) return { archived: 0, sourceIds: [] };

  const marker = opts.reason ?? 'archived:consolidation';
  const db = await getDb();
  const inList = sql.join(ids.map(id => sql`${id}`), sql`, `);

  const res = await db.execute(sql`
    UPDATE knowledge_chunks
    SET is_current = false,
        superseded_by = ${marker}
    WHERE namespace = ${namespace}
      AND source_id IN (${inList})
      AND is_current = true
    RETURNING source_id
  `);

  const archived = (res.rows as Array<{ source_id: string }>).map(r => r.source_id);
  return { archived: archived.length, sourceIds: archived };
}

// ── Weekly consolidation schedule template ───────────────────────────────────

/**
 * Ready-to-insert `taskSchedules` payload for the weekly knowledge
 * consolidation agent task (spec §5 steps 1–4). NOT auto-enabled anywhere —
 * opt a workspace in via `bun run seed:knowledge-consolidation` or by creating
 * a schedule from this template through the schedules API / create_schedule.
 */
export const WEEKLY_CONSOLIDATION_SCHEDULE = {
  name: 'knowledge-consolidation',
  cronExpression: '0 6 * * 1', // Mondays 06:00 (schedule timezone)
  timezone: 'UTC',
  maxConcurrentFromSchedule: 1,
  taskTemplate: {
    title: 'Weekly knowledge consolidation',
    description: `Consolidate this workspace's knowledge store: merge near-duplicates, archive decayed noise, and leave an auditable report. Deterministic queries surface candidates — YOU judge every candidate before acting. Never delete anything; archiving flips is_current=false and stays recoverable.

Step 1 — find near-duplicates:
Call \`buildd_memory\` action=consolidate_knowledge op=find_duplicates (default corpora memory+task, cosine > 0.92). Read each pair's previews and decide whether they truly describe the same fact. Similar-but-distinct entries (e.g. two different gotchas about the same file) are NOT duplicates — leave them.

Step 2 — merge true duplicates:
- memory corpus: the memory service is the source of truth. Pick the survivor (usually the newer or more complete entry), fold any unique detail from the loser into it via \`buildd_memory\` action=update, and pass supersedes=[<loser memory id>] so the loser drops out of default retrieval.
- task corpus: task outcomes have no upstream service; archive the older chunk of the pair via op=archive.

Step 3 — archive decayed noise:
Call op=find_decayed (task+artifact chunks past 6× their corpus half-life with zero retrieval hits). Sanity-check the previews — anything that still looks load-bearing stays. Archive the rest with op=archive (corpus + sourceIds).

Step 4 — emit a consolidation report:
Create a report artifact via \`buildd\` action=create_artifact type=report title "Knowledge consolidation <date>" listing: pairs merged (survivor ← loser), chunks archived (id + reason), and pairs/candidates deliberately left alone. The report is itself indexed and is the audit trail for this run.`,
    priority: 1,
  },
} as const;

// ── Weekly workspace digest schedule template ─────────────────────────────────

/**
 * Ready-to-insert `taskSchedules` payload for the weekly workspace digest agent
 * task (spec §6.2 / D2). The agent synthesises the last 7 days of activity —
 * merged PRs, completed tasks, new memories — into a concise digest and saves
 * it as a `type=summary` artifact, which the artifact-mirroring pipeline then
 * auto-indexes into the knowledge store (so next week's digest and claim-time
 * injection can retrieve it). NOT auto-enabled anywhere — opt a workspace in via
 * `bun run seed:knowledge-digest` or by creating a schedule from this template
 * through the schedules API / create_schedule. Runs an hour after the
 * consolidation schedule so it digests a freshly-consolidated store.
 */
export const WEEKLY_DIGEST_SCHEDULE = {
  name: 'knowledge-digest',
  cronExpression: '0 7 * * 1', // Mondays 07:00 (schedule timezone), after consolidation at 06:00
  timezone: 'UTC',
  maxConcurrentFromSchedule: 1,
  taskTemplate: {
    title: 'Weekly workspace digest',
    description: `Write this workspace's weekly digest: a concise, human-readable summary of the last 7 days of activity, saved as a summary artifact that is auto-indexed into the knowledge store. Report only what actually happened — never invent activity. If a source is empty, say so briefly and move on.

Step 1 — gather the last 7 days:
- Completed work: \`buildd\` action=list_tasks (filter to tasks completed in the last 7 days). Note titles, outcomes, and the PRs they merged.
- Merged PRs: read the PR references on those completed tasks (and \`buildd\` action=query_events for merge events if available) — capture PR number, title, and the one-line "what changed".
- New knowledge: \`buildd_memory\` action=search for memories saved in the last 7 days — capture the durable decisions/gotchas worth resurfacing.

Step 2 — synthesise:
Write a tight digest (aim for under ~400 words) with these sections, omitting any that are empty:
- **Shipped** — merged PRs / completed tasks, one bullet each (what changed and why it matters).
- **Decisions & learnings** — new memories and notable outcomes.
- **In flight / carry-over** — anything still open worth flagging.
Lead with a one-sentence "the week in a line" summary. No filler, no restating the prompt.

Step 3 — save as an indexed artifact:
Create the digest via \`buildd\` action=create_artifact type=summary, title "Weekly digest <week-of date>". Because it is a summary artifact it is mirrored into the knowledge store automatically — do NOT separately save it as a memory. That is the whole deliverable; do not open a PR.`,
    priority: 1,
  },
} as const;
