import { loadQuestionContext } from '@/lib/chat-objects/load-question-object';
import { getChatAvailability } from '@/lib/chat-availability';
import { ownConversationForMission, questionFocusHref } from '@/lib/chat/conversations';

/**
 * Where an answer link (`/app/tasks/:id?respond=1`, what notifications and
 * Pushover send; the old /respond page redirects there) goes when the question
 * folds into chat (knowledge-base: buildd/design/agent-chat.md, "The respond
 * page folds in"): the reader's own conversation for this mission, with the
 * question card in focus, when chat is on for them. Null keeps the reader on
 * the task page, whose reply box is the answer surface.
 */
export async function answerInChatHref(taskId: string, userId: string): Promise<string | null> {
  const ctx = await loadQuestionContext(taskId, userId);
  if (!ctx || !ctx.view.open || !ctx.view.workerId || !ctx.task.missionId) return null;
  const conversationId = await ownConversationForMission(ctx.task.missionId, userId).catch(() => null);
  if (!conversationId) return null;
  if (!(await getChatAvailability(userId, ctx.task.teamId ?? null)).available) return null;
  return questionFocusHref(conversationId, { workerId: ctx.view.workerId, taskId });
}
