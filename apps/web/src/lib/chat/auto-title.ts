/**
 * Name the conversation after its first exchange, on the budget tier, so the
 * user never has to. Runs after the response; never overwrites a title the
 * user set (store.setConversationTitle is conditional on title_source='auto').
 */

import { generateText, type UIMessage } from 'ai';
import { resolveChatModel } from './models';
import { pingConversation, setConversationTitle, type ConversationRow } from './store';

function transcript(messages: UIMessage[]): string {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-4)
    .map(m => `${m.role}: ${m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join(' ')}`)
    .join('\n')
    .slice(0, 3000);
}

export async function autoTitleConversation(
  conversation: ConversationRow,
  messages: UIMessage[],
  userId: string,
  deps: { generate?: typeof generateText } = {},
): Promise<void> {
  try {
    const model = await resolveChatModel({
      tier: 'budget', teamId: conversation.teamId, workspaceId: conversation.workspaceId, userId,
    });
    if (!model.ok) return;
    const { text } = await (deps.generate ?? generateText)({
      model: model.model,
      instructions: 'Write a title for this conversation: 3 to 7 words, sentence case, no quotes, no trailing period. Reply with the title only.',
      prompt: transcript(messages),
      maxOutputTokens: 30,
      abortSignal: AbortSignal.timeout(8000),
    });
    const title = await setConversationTitle(conversation.id, text, 'auto');
    if (title) await pingConversation(conversation.id, 'title');
  } catch (e) {
    console.warn(`[chat] auto-title failed for conversation ${conversation.id}:`, e);
  }
}
