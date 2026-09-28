/**
 * Name the conversation after its first exchange, so the user never has to.
 * The kit's pipeline (`titleConversation`): a short first message is its own
 * title; otherwise one call on the budget tier. Runs after the response;
 * never overwrites a title the user set (store.setConversationTitle is
 * conditional on title_source='auto').
 */

import type { UIMessage } from 'ai';
import { titleConversation } from '@builddai/ai-kit/chat/server';
import { resolveChatModel } from './models';
import { pingConversation, setConversationTitle, type ConversationRow } from './store';

export async function autoTitleConversation(
  conversation: ConversationRow,
  messages: UIMessage[],
  userId: string,
  deps: {
    generate?: Parameters<typeof titleConversation>[0]['generate'];
    resolveModel?: typeof resolveChatModel;
    save?: typeof setConversationTitle;
    ping?: typeof pingConversation;
  } = {},
): Promise<void> {
  const warn = (e: unknown) => console.warn(`[chat] auto-title failed for conversation ${conversation.id}:`, e);
  try {
    const result = await titleConversation({
      messages,
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
    if (!result) return;
    const title = await (deps.save ?? setConversationTitle)(conversation.id, result.title, 'auto');
    if (title) await (deps.ping ?? pingConversation)(conversation.id, 'title');
  } catch (e) {
    warn(e);
  }
}
