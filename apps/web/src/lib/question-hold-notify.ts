/**
 * The notify half of held questions (lib/question-hold.ts): the one way a
 * parked question reaches a person — the team's Pushover channel, the
 * originating chat conversation, and the subscriptions ledger. Lives in the
 * notifications module; core code (the hold logic) receives it injected.
 */
import { questionNotificationText, withSanitizedBrief, type BriefedQuestion } from '@buildd/core/question-brief';
import { notifyTeamOf } from './notify';
import { emit } from './core-emit';
import type { ParkedQuestion } from './question-hold';

/** Fire-and-forget: never throws, never awaits delivery. */
export function notifyParkedQuestion(p: ParkedQuestion, opts: { recordLedger: boolean }): void {
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const note = questionNotificationText(withSanitizedBrief(p.waitingFor) as unknown as BriefedQuestion, { sensitive: p.sensitive });
  const prompt = typeof p.waitingFor.prompt === 'string' ? p.waitingFor.prompt : undefined;
  void notifyTeamOf({ workspaceId: p.workspaceId }, 'needsAttention', {
    title: note.title,
    message: note.message,
    url: `${appBaseUrl}/app/tasks/${p.taskId}/respond`,
    urlTitle: 'Respond',
    priority: 0,
  });
  if (!p.taskId) return;
  const taskId = p.taskId;
  void import('./chat/mission-events')
    .then(m => m.postQuestionEvent({ taskId, workerId: p.workerId, prompt, sensitive: p.sensitive }))
    .catch(() => {});
  // emit never throws. The PATCH route records the ledger
  // row itself, after its worker write lands; the resurface sweep has already
  // won its claim, so it records here.
  if (opts.recordLedger) void emit({ type: 'task.needs_input', taskId, workerId: p.workerId, prompt });
}
