import { db } from '@buildd/core/db';
import { missionNotes, workers, tasks } from '@buildd/core/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { MissionNoteType, MissionNoteAuthorType } from '@buildd/shared';

/**
 * Who did this to the mission. Resolved once per request and threaded into
 * every `postMissionFeedEvent` call in that request, so a single PATCH that
 * changes five things attributes all five to the same actor.
 *
 * 'agent' vs 'mcp' is the distinction the mission feed used to collapse into
 * "System": a worker acting from inside one of the mission's own tasks vs an
 * outside caller (script, another agent) hitting the API/MCP with an account
 * token but no task context. 'system' is reserved for transitions with no
 * external caller at all — the heartbeat/dormancy closer.
 */
export type FeedActor =
  | { kind: 'user'; id: string; label: string }
  | { kind: 'agent'; id: string; label: string }
  | { kind: 'mcp'; id: string; label: string }
  | { kind: 'system'; id: null; label: string };

/**
 * Resolve the calling actor from the same auth values every route already
 * computes (`getCurrentUser` + `authenticateApiKey`), plus an optional
 * `actorWorkerId` — set by `manage_missions`/`link_task` MCP calls from
 * `ctx.workerId` (see packages/core/mcp-tools.ts) the same way task creation
 * already threads `createdByWorkerId` through. A worker id resolves to the
 * task it's running, which is what makes an in-task agent's edit read as
 * "agent (task X)" instead of an anonymous API call.
 */
export async function resolveFeedActor(opts: {
  user: { id: string; email?: string | null; name?: string | null } | null;
  apiAccount: { id: string; name?: string | null } | null;
  actorWorkerId?: string | null;
}): Promise<FeedActor> {
  if (opts.user) {
    return { kind: 'user', id: opts.user.id, label: opts.user.email ?? opts.user.name ?? opts.user.id };
  }

  if (opts.actorWorkerId) {
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, opts.actorWorkerId),
      columns: { id: true, taskId: true },
    });
    if (worker?.taskId) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { id: true, title: true },
      });
      if (task) {
        return { kind: 'agent', id: task.id, label: `task "${task.title}" (${task.id})` };
      }
    }
    return { kind: 'agent', id: opts.actorWorkerId, label: `worker ${opts.actorWorkerId}` };
  }

  if (opts.apiAccount) {
    return { kind: 'mcp', id: opts.apiAccount.id, label: `account "${opts.apiAccount.name ?? opts.apiAccount.id}"` };
  }

  return { kind: 'system', id: null, label: 'system' };
}

/** For genuine engine-internal transitions — names the predicate that fired, never just "System". */
export function systemActor(predicate: string): FeedActor {
  return { kind: 'system', id: null, label: predicate };
}

const DEFAULT_COLLAPSE_WINDOW_MS = 5 * 60 * 1000;

/** Replace (or append) the line for `field` in a collapsed config-change body. */
function mergeConfigLine(existingBody: string | null, newLine: string): string {
  const field = newLine.split(':')[0];
  const lines = (existingBody ?? '').split('\n').filter(Boolean);
  const kept = lines.filter(line => !line.startsWith(`${field}:`));
  kept.push(newLine);
  return kept.join('\n');
}

/**
 * The single writer of mission-feed rows (`mission_notes`). Every mutation
 * site — UI, REST API, MCP — should route through here instead of inserting
 * into `missionNotes` directly, so actor attribution and config-churn
 * collapsing are applied uniformly rather than reimplemented per call site.
 *
 * `collapseKey` groups low-signal repeated edits (config churn) from the same
 * actor within `collapseWindowMs`: instead of one row per field per edit, the
 * most recent matching row is updated in place (its `createdAt` bumped so it
 * still sorts to the top of the feed) and `body` accumulates one line per
 * field, keyed on the text before the first `:`. Omit `collapseKey` for
 * events that should always get their own row (status changes, task
 * links, criteria edits).
 */
export async function postMissionFeedEvent(opts: {
  missionId: string;
  type: MissionNoteType;
  title: string;
  body?: string | null;
  actor: FeedActor;
  taskId?: string | null;
  collapseKey?: string;
  collapseWindowMs?: number;
}): Promise<void> {
  const authorType: MissionNoteAuthorType = opts.actor.kind;

  if (opts.collapseKey) {
    const since = new Date(Date.now() - (opts.collapseWindowMs ?? DEFAULT_COLLAPSE_WINDOW_MS));
    const existing = await db.query.missionNotes.findFirst({
      where: and(
        eq(missionNotes.missionId, opts.missionId),
        eq(missionNotes.collapseKey, opts.collapseKey),
        gte(missionNotes.createdAt, since),
      ),
      orderBy: [desc(missionNotes.createdAt)],
    });

    if (existing) {
      const mergedBody = opts.body ? mergeConfigLine(existing.body, opts.body) : existing.body;
      await db.update(missionNotes)
        .set({
          title: opts.title,
          body: mergedBody,
          actorLabel: opts.actor.label,
          collapseCount: (existing.collapseCount ?? 1) + 1,
          createdAt: new Date(),
        })
        .where(eq(missionNotes.id, existing.id));

      await triggerEvent(channels.mission(opts.missionId), events.MISSION_NOTE_POSTED, {
        noteId: existing.id,
        type: opts.type,
        authorType,
        title: opts.title,
      }).catch(e => console.error('[mission-feed] pusher failed for collapsed note:', e));
      return;
    }
  }

  const [note] = await db.insert(missionNotes).values({
    missionId: opts.missionId,
    taskId: opts.taskId ?? null,
    authorType,
    actorLabel: opts.actor.label,
    type: opts.type,
    title: opts.title,
    body: opts.body ?? null,
    status: 'open',
    collapseKey: opts.collapseKey ?? null,
    collapseCount: 1,
  }).returning();

  await triggerEvent(channels.mission(opts.missionId), events.MISSION_NOTE_POSTED, {
    noteId: note.id,
    type: note.type,
    authorType: note.authorType,
    title: note.title,
  }).catch(e => console.error('[mission-feed] pusher failed for note:', e));
}

/** Display name for a goal criterion, matching the fallback used elsewhere (mcp-tools.ts, MissionFeed). */
export function criterionLabel(c: Record<string, unknown> | null | undefined): string {
  return (c?.label as string) ?? (c?.description as string) ?? (c?.type as string) ?? '(malformed criterion)';
}

/**
 * Structural diff between two goalCriteria arrays. Criteria have no stable id,
 * so a criterion is "added"/"removed" by whole-object identity — editing one
 * field of an existing criterion therefore reads as one removal + one
 * addition, which is exactly the "changing produces an entry too" behavior
 * the feed needs.
 */
export function diffGoalCriteria(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): { added: Record<string, unknown>[]; removed: Record<string, unknown>[] } {
  const key = (c: Record<string, unknown>) => JSON.stringify(c);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter(c => !beforeKeys.has(key(c))),
    removed: before.filter(c => !afterKeys.has(key(c))),
  };
}
