/**
 * Planning-mode updates for missions filed from chat post back into the
 * conversation they came from (docs/design/agent-chat.md → Should the
 * Orchestrator be the chat?). The message is a `role: 'event'` row with one
 * `data-buildd-event` part carrying object refs; the ping carries no text.
 *
 * Best-effort everywhere: a chat side effect must never fail the worker PATCH
 * that triggered it.
 */

import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import { CHAT_EVENT_PART_TYPE, type BuilddObjectRef, type ChatEventData, type ChatEventKind } from '@buildd/shared';
import { insertMessage, pingConversation } from './store';

async function conversationForTask(taskId: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, title: true, missionId: true, workspaceId: true, result: true },
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
    await post(found.conversationId, {
      event: 'question' satisfies ChatEventKind,
      objects: [question],
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
    const n = planLength(found.task.result);
    if (n === null) return;
    const mission: BuilddObjectRef = {
      kind: 'mission', id: found.mission.id, workspaceId: found.mission.workspaceId ?? null,
      title: found.mission.title, fallbackText: `Mission: ${found.mission.title}`,
    };
    await post(found.conversationId, {
      event: 'plan_ready',
      objects: [mission],
      text: `Plan ready: ${n} task${n === 1 ? '' : 's'}.`,
    });
  } catch (e) {
    console.warn('[chat] plan event not posted:', e);
  }
}
