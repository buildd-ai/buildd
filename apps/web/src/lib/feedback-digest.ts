/**
 * Feedback-to-memory processing pipeline.
 *
 * Analyzes recent user feedback (down-votes & dismissals) on AI content,
 * identifies patterns, and persists distilled learnings to the team memory pool
 * so future agent runs produce more relevant output.
 *
 * Each memory is filed under the project key of the workspace the rated
 * content belongs to (memoryProjectKey, the rule every memory read uses) and
 * mirrored into the recall index through the shared write helper. Feedback
 * that cannot be tied to a workspace key writes nothing: a memory with no
 * project is invisible to every project-scoped read.
 */

import { db } from '@buildd/core/db';
import { userFeedback, missionNotes, artifacts, workspaces } from '@buildd/core/db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { MemoryStore } from '@buildd/core/memory-store';
import { memoryProjectKey } from '@buildd/core/project-scope';
import { saveMemory, updateMemory } from '@buildd/core/memory-write';
import type { KnowledgeStore } from '@buildd/core/knowledge-store/types';
import { getMemoryStoreForTeam, getMemoryIndexStore } from '@/lib/memory-helper';
import { resolveFeedbackEntityWorkspaces } from '@/lib/feedback-entity-workspace';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// ── Types ─────────────────────────────────────────────────────────────────────

type EntityType = 'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat';
type Signal = 'up' | 'down' | 'dismiss';

interface FeedbackRow {
  id: string;
  teamId: string;
  userId: string;
  entityType: EntityType;
  entityId: string;
  signal: Signal;
  comment: string | null;
  createdAt: Date;
}

interface PatternBucket {
  /** memories.project key the pattern is filed under (memoryProjectKey of the rated workspace). */
  project: string;
  entityType: EntityType;
  signal: Signal;
  count: number;
  comments: string[];
  entityIds: string[];
}

interface EntityContext {
  id: string;
  snippet: string;
  type: string;
}

interface DigestResult {
  teamId: string;
  memoriesSaved: number;
  memoriesUpdated: number;
  feedbackProcessed: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DIGEST_TAG = 'feedback-digest';
const DIGEST_SOURCE = 'feedback-digest-cron';
const MIN_SIGNALS_FOR_PATTERN = 2; // At least 2 signals to form a pattern

// ── Entity resolution ─────────────────────────────────────────────────────────

/** Fetch a short snippet for entities so memories include context about what was rejected */
async function resolveEntityContext(entityType: EntityType, entityIds: string[]): Promise<Map<string, EntityContext>> {
  const ctx = new Map<string, EntityContext>();
  if (entityIds.length === 0) return ctx;

  if (entityType === 'note') {
    const notes = await db.query.missionNotes.findMany({
      where: inArray(missionNotes.id, entityIds),
      columns: { id: true, type: true, title: true, body: true },
    });
    for (const n of notes) {
      const snippet = n.title + (n.body ? `: ${n.body.slice(0, 120)}` : '');
      ctx.set(n.id, { id: n.id, snippet, type: n.type });
    }
  }

  if (entityType === 'artifact') {
    const arts = await db.query.artifacts.findMany({
      where: inArray(artifacts.id, entityIds),
      columns: { id: true, type: true, title: true, content: true },
    });
    for (const a of arts) {
      const snippet = (a.title || 'Untitled') + (a.content ? `: ${a.content.slice(0, 120)}` : '');
      ctx.set(a.id, { id: a.id, snippet, type: a.type });
    }
  }

  // summary, orchestration, heartbeat — these are embedded in other tables (workers, missions)
  // and don't have simple lookups. We skip context for these for now.

  return ctx;
}

// ── Pattern analysis ──────────────────────────────────────────────────────────

function bucketFeedback(rows: FeedbackRow[], projectOf: Map<string, string>): PatternBucket[] {
  const map = new Map<string, PatternBucket>();

  for (const r of rows) {
    // A memory with no project is invisible to every project-scoped read, so
    // feedback that cannot be tied to a workspace key is not written at all.
    const project = projectOf.get(r.id);
    if (!project) continue;
    const k = `${project}::${r.entityType}::${r.signal}`;
    if (!map.has(k)) {
      map.set(k, {
        project,
        entityType: r.entityType,
        signal: r.signal,
        count: 0,
        comments: [],
        entityIds: [],
      });
    }
    const bucket = map.get(k)!;
    bucket.count++;
    if (r.comment) bucket.comments.push(r.comment);
    bucket.entityIds.push(r.entityId);
  }

  return Array.from(map.values());
}

// ── Workspace / project resolution ────────────────────────────────────────────

/**
 * The memory project key for each feedback row, by the same rule every memory
 * read uses (memoryProjectKey): only workspaces in the row's own team, never a
 * sensitive one, and never a key shared with a sensitive workspace.
 */
async function resolveFeedbackProjects(teamId: string, rows: FeedbackRow[]): Promise<Map<string, string>> {
  const wsOf = await resolveFeedbackEntityWorkspaces(rows.map(r => ({ key: r.id, entityType: r.entityType, entityId: r.entityId })));
  const out = new Map<string, string>();
  if (wsOf.size === 0) return out;
  const teamWorkspaces = await db.query.workspaces.findMany({
    where: eq(workspaces.teamId, teamId),
    columns: { id: true, teamId: true, repo: true, name: true, dataClass: true },
  });
  const byId = new Map(teamWorkspaces.map(w => [w.id, w]));
  const authorOf = new Map(rows.map(r => [r.id, r.userId]));
  // Only an author who can access the workspace speaks for it: a vote from
  // anyone else is not counted toward that workspace's pattern.
  const accessChecks = new Map<string, Promise<boolean>>();
  const canAccess = (userId: string, wsId: string) => {
    const k = `${userId}::${wsId}`;
    if (!accessChecks.has(k)) {
      accessChecks.set(k, verifyWorkspaceAccess(userId, wsId).then(a => !!a && a.teamId === teamId, () => false));
    }
    return accessChecks.get(k)!;
  };
  for (const [rowId, wsId] of wsOf) {
    const ws = byId.get(wsId);
    if (!ws || ws.teamId !== teamId) continue;
    const author = authorOf.get(rowId);
    if (!author || !(await canAccess(author, wsId))) continue;
    const key = memoryProjectKey(ws, teamWorkspaces);
    if (key) out.set(rowId, key);
  }
  return out;
}

/** Build human-readable memory content from a pattern bucket */
async function buildMemoryContent(bucket: PatternBucket): Promise<string> {
  const { entityType, signal, count, comments, entityIds } = bucket;

  const action = signal === 'dismiss' ? 'dismissed' : 'downvoted';
  const lines: string[] = [
    `Users ${action} ${count} ${entityType} item(s) in the recent window.`,
    '',
  ];

  // Add entity context if available
  const entityCtx = await resolveEntityContext(entityType, entityIds.slice(0, 10));
  if (entityCtx.size > 0) {
    lines.push('**Rejected content examples:**');
    for (const [, ctx] of entityCtx) {
      lines.push(`- [${ctx.type}] ${ctx.snippet}`);
    }
    lines.push('');
  }

  // Raw comment text is never copied in: it is free text from a person, and
  // this memory is injected into agent prompts. Only the count is kept.
  if (comments.length > 0) {
    lines.push(`${comments.length} of these came with a comment (not reproduced here).`, '');
  }

  // Actionable guidance
  lines.push('**Guidance for agents:**');
  if (entityType === 'note' && signal === 'dismiss') {
    lines.push('- Reduce frequency of status-only or low-value notes');
    lines.push('- Focus notes on decisions, warnings, and questions that need user input');
  } else if (entityType === 'note' && signal === 'down') {
    lines.push('- Improve quality and relevance of agent notes');
    lines.push('- Avoid generic or repetitive updates');
  } else if (entityType === 'artifact' && signal === 'dismiss') {
    lines.push('- Be more selective about which artifacts to create');
    lines.push('- Only create artifacts when the content is genuinely useful');
  } else if (entityType === 'artifact' && signal === 'down') {
    lines.push('- Improve artifact content quality, accuracy, and depth');
  } else if (entityType === 'summary') {
    lines.push(`- Task summaries are being ${action} — make them more concise and actionable`);
  } else if (entityType === 'orchestration') {
    lines.push(`- Orchestration decisions are being ${action} — reconsider task breakdown strategy`);
  } else if (entityType === 'heartbeat') {
    lines.push(`- Heartbeat reports are being ${action} — adjust frequency or content`);
  }

  return lines.join('\n');
}

// ── Memory persistence ────────────────────────────────────────────────────────

async function persistPattern(
  memClient: MemoryStore,
  index: KnowledgeStore,
  teamId: string,
  bucket: PatternBucket,
): Promise<'saved' | 'updated' | 'skipped'> {
  const action = bucket.signal === 'dismiss' ? 'dismissed' : 'downvoted';
  const title = `User feedback: ${bucket.entityType} content frequently ${action}`;
  const tags = [DIGEST_TAG, 'user-preference', bucket.entityType, bucket.signal];

  // Check for an existing digest memory for this pattern in this project
  const existing = await memClient.search({
    query: `feedback ${bucket.entityType} ${action}`,
    type: 'pattern',
    project: bucket.project,
  });

  const content = await buildMemoryContent(bucket);
  const writeOpts = { teamId, knowledgeStore: index, via: 'feedback-digest' as const };

  // Find an existing digest memory for this exact pattern
  if (existing.results.length > 0) {
    const fullMemories = await memClient.batch(existing.results.map(r => r.id));
    const match = fullMemories.memories.find(m =>
      m.source === DIGEST_SOURCE &&
      m.project === bucket.project &&
      m.tags.includes(DIGEST_TAG) &&
      m.tags.includes(bucket.entityType) &&
      m.tags.includes(bucket.signal)
    );

    if (match) {
      await updateMemory(memClient, match.id, { content, tags }, writeOpts);
      return 'updated';
    }
  }

  // Save new memory (mirrored into the recall index by the write helper)
  await saveMemory(memClient, {
    type: 'pattern',
    title,
    content,
    project: bucket.project,
    tags,
    source: DIGEST_SOURCE,
  }, writeOpts);
  return 'saved';
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Process recent feedback and convert patterns into memory entries.
 * @param windowHours - How far back to look (default 24h)
 */
export async function runFeedbackDigest(windowHours = 24): Promise<{
  results: DigestResult[];
  totalFeedback: number;
}> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // 1. Query recent negative feedback
  const rows = await db.query.userFeedback.findMany({
    where: and(
      gte(userFeedback.createdAt, since),
      inArray(userFeedback.signal, ['down', 'dismiss']),
    ),
  }) as FeedbackRow[];

  if (rows.length === 0) {
    return { results: [], totalFeedback: 0 };
  }

  // 2. Group by team
  const byTeam = new Map<string, FeedbackRow[]>();
  for (const r of rows) {
    if (!byTeam.has(r.teamId)) byTeam.set(r.teamId, []);
    byTeam.get(r.teamId)!.push(r);
  }

  // 3. Process each team
  const results: DigestResult[] = [];
  const index = getMemoryIndexStore();

  for (const [teamId, teamRows] of byTeam) {
    const memClient = await getMemoryStoreForTeam(null, teamId);
    if (!memClient) {
      console.warn(`[feedback-digest] Could not resolve memory store for team ${teamId}, skipping`);
      continue;
    }

    const buckets = bucketFeedback(teamRows, await resolveFeedbackProjects(teamId, teamRows));
    let saved = 0;
    let updated = 0;

    for (const bucket of buckets) {
      if (bucket.count < MIN_SIGNALS_FOR_PATTERN) continue;

      const result = await persistPattern(memClient, index, teamId, bucket);
      if (result === 'saved') saved++;
      if (result === 'updated') updated++;
    }

    results.push({
      teamId,
      memoriesSaved: saved,
      memoriesUpdated: updated,
      feedbackProcessed: teamRows.length,
    });
  }

  return { results, totalFeedback: rows.length };
}

/**
 * Get a summary of positive feedback too (for completeness reporting).
 * Positive signals don't generate memories but are useful for diagnostics.
 */
export async function getFeedbackStats(windowHours = 24): Promise<{
  total: number;
  bySignal: Record<string, number>;
  byEntityType: Record<string, number>;
}> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const rows = await db.query.userFeedback.findMany({
    where: gte(userFeedback.createdAt, since),
    columns: { signal: true, entityType: true },
  });

  const bySignal: Record<string, number> = {};
  const byEntityType: Record<string, number> = {};

  for (const r of rows) {
    bySignal[r.signal] = (bySignal[r.signal] || 0) + 1;
    byEntityType[r.entityType] = (byEntityType[r.entityType] || 0) + 1;
  }

  return { total: rows.length, bySignal, byEntityType };
}
