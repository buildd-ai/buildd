/**
 * Feedback-to-memory processing pipeline.
 *
 * Analyzes recent user feedback (down-votes & dismissals) on AI content,
 * identifies patterns, and persists distilled learnings to the memory service
 * so future agent runs produce more relevant output.
 */

import { db } from '@buildd/core/db';
import { userFeedback, teams, missionNotes, artifacts } from '@buildd/core/db/schema';
import { eq, and, gte, inArray, sql } from 'drizzle-orm';
import { MemoryClient } from '@buildd/core/memory-client';

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

function bucketFeedback(rows: FeedbackRow[]): PatternBucket[] {
  const key = (r: FeedbackRow) => `${r.entityType}::${r.signal}`;
  const map = new Map<string, PatternBucket>();

  for (const r of rows) {
    const k = key(r);
    if (!map.has(k)) {
      map.set(k, {
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

  // Add user comments
  if (comments.length > 0) {
    lines.push('**User comments:**');
    for (const c of comments.slice(0, 10)) {
      lines.push(`- "${c}"`);
    }
    lines.push('');
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

async function getMemoryClientForTeam(teamId: string): Promise<MemoryClient | null> {
  const url = process.env.MEMORY_API_URL;
  if (!url) return null;

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { memoryApiKey: true },
  });

  if (!team?.memoryApiKey) return null;
  return new MemoryClient(url, team.memoryApiKey);
}

async function persistPattern(
  memClient: MemoryClient,
  bucket: PatternBucket,
): Promise<'saved' | 'updated' | 'skipped'> {
  const action = bucket.signal === 'dismiss' ? 'dismissed' : 'downvoted';
  const title = `User feedback: ${bucket.entityType} content frequently ${action}`;
  const tags = [DIGEST_TAG, 'user-preference', bucket.entityType, bucket.signal];

  // Check for existing memory with same tag combo
  const existing = await memClient.search({
    query: `feedback ${bucket.entityType} ${action}`,
    type: 'pattern',
  });

  const content = await buildMemoryContent(bucket);

  // Find an existing digest memory for this exact pattern
  if (existing.results.length > 0) {
    const fullMemories = await memClient.batch(existing.results.map(r => r.id));
    const match = fullMemories.memories.find(m =>
      m.source === DIGEST_SOURCE &&
      m.tags.includes(DIGEST_TAG) &&
      m.tags.includes(bucket.entityType) &&
      m.tags.includes(bucket.signal)
    );

    if (match) {
      await memClient.update(match.id, { content, tags });
      return 'updated';
    }
  }

  // Save new memory
  await memClient.save({
    type: 'pattern',
    title,
    content,
    tags,
    source: DIGEST_SOURCE,
  });
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

  for (const [teamId, teamRows] of byTeam) {
    const memClient = await getMemoryClientForTeam(teamId);
    if (!memClient) {
      console.warn(`[feedback-digest] No memory client for team ${teamId}, skipping`);
      continue;
    }

    const buckets = bucketFeedback(teamRows);
    let saved = 0;
    let updated = 0;

    for (const bucket of buckets) {
      if (bucket.count < MIN_SIGNALS_FOR_PATTERN) continue;

      const result = await persistPattern(memClient, bucket);
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
