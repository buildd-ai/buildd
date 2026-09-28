/**
 * Planning-mode updates for missions filed from chat post back into the
 * conversation they came from (docs/design/agent-chat.md → Should the
 * Orchestrator be the chat?). The message is a `role: 'event'` row with one
 * `data-buildd-event` part carrying object refs; the ping carries no text.
 *
 * Best-effort everywhere: a chat side effect must never fail the worker PATCH
 * that triggered it.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import {
  CHAT_EVENT_PART_TYPE,
  VISUAL_AUDITOR_ROLE_SLUG,
  type BuilddObjectRef,
  type ChatEventData,
  type ChatEventKind,
  type VisualReviewModel,
} from '@buildd/shared';
import { surfaceAuditRound } from '@buildd/core/surface-audit';
import { insertMessage, pingConversation } from './store';
import {
  VISUAL_REVIEW_MOMENT_KEYS, roundMomentFor, visualReviewEventData, visualReviewEventText,
  type VisualReviewMoment, type VisualReviewMomentKey,
} from './visual-review-text';

function missionObjectRef(mission: { id: string; title: string; workspaceId: string | null }): BuilddObjectRef {
  return {
    kind: 'mission', id: mission.id, workspaceId: mission.workspaceId ?? null,
    title: mission.title, fallbackText: `Mission: ${mission.title}`,
  };
}

async function conversationForTask(taskId: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, title: true, missionId: true, workspaceId: true, result: true, roleSlug: true, context: true },
  });
  if (!task?.missionId) return null;
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { id: true, title: true, conversationId: true, workspaceId: true },
  });
  if (!mission?.conversationId) return null;
  return { task, mission, conversationId: mission.conversationId };
}

async function post(conversationId: string, data: ChatEventData): Promise<void> {
  const row = await insertMessage({
    conversationId,
    role: 'event',
    parts: [{ type: CHAT_EVENT_PART_TYPE, data }],
  });
  await pingConversation(conversationId, 'event', row.id);
}

function planLength(result: unknown): number | null {
  const plan = (result as { structuredOutput?: { plan?: unknown } } | null)?.structuredOutput?.plan;
  return Array.isArray(plan) ? plan.length : null;
}

/** A worker on a chat-filed mission is waiting on a question. */
export async function postQuestionEvent(input: { taskId: string; workerId: string; prompt?: string | null; sensitive?: boolean }) {
  try {
    const found = await conversationForTask(input.taskId);
    if (!found) return;
    const prompt = input.sensitive ? 'A worker is waiting for your answer' : (input.prompt || 'A worker is waiting for your answer');
    const question: BuilddObjectRef = {
      kind: 'question', id: input.workerId, taskId: input.taskId, missionId: found.mission.id,
      workspaceId: found.task.workspaceId ?? null, title: prompt.slice(0, 120), fallbackText: `Question: ${prompt.slice(0, 280)}`,
    };
    // The visual audit's boot-failure question also names the mission, so the
    // mission card (its Screens line and the answer buttons) shows with it.
    const isAudit = (found.task as { roleSlug?: string | null }).roleSlug === VISUAL_AUDITOR_ROLE_SLUG;
    await post(found.conversationId, {
      event: 'question' satisfies ChatEventKind,
      objects: isAudit ? [question, missionObjectRef(found.mission)] : [question],
      text: `A worker on "${found.mission.title}" is asking you something.`,
    });
  } catch (e) {
    console.warn('[chat] question event not posted:', e);
  }
}

/** A task finished; if it produced a plan for a chat-filed mission, say so. */
export async function postTaskCompletedEvent(input: { taskId: string }) {
  try {
    const found = await conversationForTask(input.taskId);
    if (!found) return;
    // A visual audit round finished: its verdict counts (or the all-clear).
    if ((found.task as { roleSlug?: string | null }).roleSlug === VISUAL_AUDITOR_ROLE_SLUG) {
      await postVisualAuditRoundEvent({ taskId: found.task.id, missionId: found.mission.id, round: surfaceAuditRound(found.task) });
      return;
    }
    const n = planLength(found.task.result);
    if (n === null) return;
    const mission = missionObjectRef(found.mission);
    await post(found.conversationId, {
      event: 'plan_ready',
      objects: [mission],
      text: `Plan ready: ${n} task${n === 1 ? '' : 's'}.`,
    });
  } catch (e) {
    console.warn('[chat] plan event not posted:', e);
  }
}

// ── Visual review (docs/design/visual-qa-human-review.md, Chat) ─────────────

export {
  VISUAL_REVIEW_MOMENT_KEYS, roundMomentFor, visualReviewEventData, visualReviewEventText,
  type VisualReviewMoment, type VisualReviewMomentKey,
} from './visual-review-text';

/**
 * The atomic once-only claim of a moment on the audit task: set
 * `context.visualQa.<key>` WHERE it IS NULL. With RETURNING, exactly one of
 * any number of concurrent sweeps or PATCHes gets the row back and posts.
 * `key` is a fixed name (VISUAL_REVIEW_MOMENT_KEYS), bound as a parameter.
 */
export function visualQaMomentClaim(taskId: string, key: VisualReviewMomentKey, at: Date): { set: SQL; where: SQL } {
  // A context or visualQa that is not an object (SQL NULL, JSON null, an
  // array) is treated as empty rather than failing the sweep.
  const ctx = sql`(case when jsonb_typeof(${tasks.context}) = 'object' then ${tasks.context} else '{}'::jsonb end)`;
  const qa = sql`(case when jsonb_typeof(${tasks.context} -> 'visualQa') = 'object' then ${tasks.context} -> 'visualQa' else '{}'::jsonb end)`;
  const set = sql`jsonb_set(${ctx}, '{visualQa}', ${qa} || jsonb_build_object(${key}::text, ${at.toISOString()}::text))`;
  const where = and(eq(tasks.id, taskId), sql`(${tasks.context} -> 'visualQa' ->> ${key}) is null`)!;
  return { set, where };
}

export async function claimVisualReviewMoment(taskId: string, key: VisualReviewMomentKey, at = new Date()): Promise<boolean> {
  const { set, where } = visualQaMomentClaim(taskId, key, at);
  const rows = await db.update(tasks).set({ context: set as never }).where(where).returning({ id: tasks.id });
  return rows.length > 0;
}

/**
 * Post a visual review moment into the conversation the mission was filed
 * from. No conversation: nothing is posted and no once-only mark is spent.
 * The mark lives on the audit task (`auditTaskId`, else the model's latest
 * audit), so a moment posts once per audit round. Best-effort: never throws.
 */
export async function postVisualReviewEvent(input: {
  missionId: string;
  moment: VisualReviewMoment;
  /** The model to describe. Loaded when absent. */
  model?: VisualReviewModel;
  auditTaskId?: string | null;
  fixes?: number;
  routes?: readonly string[];
  /** The round being reported, when it is not the model's latest audit. */
  round?: number;
}): Promise<boolean> {
  try {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, input.missionId),
      columns: { id: true, title: true, conversationId: true, workspaceId: true },
    });
    if (!mission?.conversationId) return false;
    const model = input.model ?? await (await import('@/lib/visual-review-load')).loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId ?? null });
    const key = VISUAL_REVIEW_MOMENT_KEYS[input.moment];
    const auditTaskId = input.auditTaskId ?? model.audit?.id ?? null;
    if (key) {
      if (!auditTaskId) return false;
      if (!(await claimVisualReviewMoment(auditTaskId, key))) return false;
    }
    await post(mission.conversationId, {
      event: 'visual_review',
      objects: [missionObjectRef(mission)],
      text: visualReviewEventText(input.moment, model, input),
      visual: visualReviewEventData(input.moment, model, input),
    });
    return true;
  } catch (e) {
    console.warn('[chat] visual review event not posted:', e);
    return false;
  }
}

/**
 * A visual-auditor task finished: post its round (or the all-clear). The
 * model is read after the task row settled, so the phase is the new one.
 *
 * The auditor files its `[surface fix]` tasks while its round is still in
 * progress, and each one opens a pending next round. So a later audit that is
 * only `pending` is expected here: the round still posts, named by its own
 * number. Only a later round that has already started makes this news stale.
 */
export async function postVisualAuditRoundEvent(input: { taskId: string; missionId: string; round?: number }): Promise<boolean> {
  try {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, input.missionId),
      columns: { id: true, conversationId: true, workspaceId: true },
    });
    if (!mission?.conversationId) return false;
    const { loadVisualReview } = await import('@/lib/visual-review-load');
    const model = await loadVisualReview({ id: mission.id, workspaceId: mission.workspaceId ?? null });
    if (model.audit && model.audit.id !== input.taskId && model.audit.status !== 'pending') return false;
    return postVisualReviewEvent({
      missionId: input.missionId, moment: roundMomentFor(model), model, auditTaskId: input.taskId,
      round: input.round,
    });
  } catch (e) {
    console.warn('[chat] visual round event not posted:', e);
    return false;
  }
}
