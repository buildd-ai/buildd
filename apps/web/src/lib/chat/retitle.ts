/**
 * Re-titling a conversation that has moved on from its auto title.
 *
 * Every few user turns, the routing decision call gets one more question
 * (`TITLE_TOPIC_QUESTION`): does the title still name what the latest message
 * is about? It rides the call routing already makes, so it adds a question,
 * never a request or a hop.
 *
 * `RETITLE_MODE`:
 *  - `shadow` (now): log the verdict as `[chat-retitle-shadow]`, rename nothing.
 *    Grep the prod logs to see how often conversations drift and how confident
 *    Jev is before turning renames on.
 *  - `live`: a confident `new_topic` re-runs the title on the recent messages
 *    (budget tier) and replaces the title only if it is still the auto title
 *    it was when the turn started.
 *  - `off`: never asks.
 *
 * A title the person set is never asked about and never replaced.
 */

import type { UIMessage } from 'ai';
import { titleConversation } from '@builddai/ai-kit/chat/server';
import { resolveChatModel } from './models';
import { pingConversation, replaceAutoTitle, type ConversationRow } from './store';
import type { TurnRoute } from './routing';
import { RETITLE_LOG_PREFIX, RETITLE_MIN_CONFIDENCE, RETITLE_MODE, type RetitleMode } from './retitle-policy';

export { RETITLE_EVERY_USER_TURNS, RETITLE_LOG_PREFIX, RETITLE_MIN_CONFIDENCE, RETITLE_MODE, titleToCheck, type RetitleMode } from './retitle-policy';

export async function handleTopicVerdict(
  conversation: ConversationRow,
  messages: UIMessage[],
  topic: NonNullable<TurnRoute['topic']>,
  userId: string,
  deps: {
    mode?: RetitleMode;
    generate?: Parameters<typeof titleConversation>[0]['generate'];
    resolveModel?: typeof resolveChatModel;
    replace?: typeof replaceAutoTitle;
    ping?: typeof pingConversation;
    log?: (line: string, data: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  const mode = deps.mode ?? RETITLE_MODE;
  const oldTitle = conversation.title;
  if (mode === 'off' || !oldTitle || conversation.titleSource !== 'auto') return;
  const renames = topic.label === 'new_topic' && topic.confidence >= RETITLE_MIN_CONFIDENCE;
  if (mode === 'shadow') {
    (deps.log ?? ((l, d) => console.info(l, d)))(RETITLE_LOG_PREFIX, {
      conversationId: conversation.id, label: topic.label, confidence: topic.confidence, wouldRename: renames,
    });
    return;
  }
  if (!renames) return;
  const warn = (e: unknown) => console.warn(`[chat] re-title failed for conversation ${conversation.id}:`, e);
  try {
    const result = await titleConversation({
      messages,
      // The built-in rule reads the first message, which is the old topic.
      skipBuiltInRule: true,
      generate: deps.generate,
      onError: warn,
      model: async () => {
        const m = await (deps.resolveModel ?? resolveChatModel)({
          tier: 'budget', teamId: conversation.teamId, workspaceId: conversation.workspaceId, userId,
        });
        if (m.ok) return { model: m.model };
        warn(new Error(`no budget model: ${m.reason} (${m.provider})`));
        return null;
      },
    });
    if (!result || result.title === oldTitle) return;
    const title = await (deps.replace ?? replaceAutoTitle)(conversation.id, oldTitle, result.title);
    if (title) await (deps.ping ?? pingConversation)(conversation.id, 'title');
  } catch (e) {
    warn(e);
  }
}
