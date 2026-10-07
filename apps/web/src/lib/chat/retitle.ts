/**
 * Re-titling a conversation that has moved on from its auto title.
 *
 * Every few user turns, the routing decision call gets one more question
 * (`TITLE_TOPIC_QUESTION`): does the title still name what the latest message
 * is about? It rides the call routing already makes, so it adds a question,
 * never a request or a hop.
 *
 * `RETITLE_MODE`:
 *  - `live` (now): a confident `new_topic` re-runs the title on the recent messages
 *    (budget tier) and replaces the title only if it is still the auto title
 *    it was when the turn started. Records every verdict durably to the decision
 *    ledger with label, confidence, status (applied/suggested/fallback), and prompt version.
 *  - `shadow`: log the verdict as `[chat-retitle-shadow]`, rename nothing.
 *    For fallback use only; not recommended for continued use.
 *  - `off`: never asks.
 *
 * A title the person set is never asked about and never replaced.
 */

import { createHash } from 'node:crypto';
import type { UIMessage } from 'ai';
import { titleConversation } from '@builddai/ai-kit/chat/server';
import { recordDecision, type DecisionLedgerInput } from '@buildd/core/decision-ledger';
import { resolveChatModel } from './models';
import { pingConversation, replaceAutoTitle, type ConversationRow } from './store';
import type { TurnRoute } from './routing';
import { RETITLE_LOG_PREFIX, RETITLE_MIN_CONFIDENCE, RETITLE_MODE, RETITLE_PROMPT_VERSION, type RetitleMode } from './retitle-policy';

export { RETITLE_EVERY_USER_TURNS, RETITLE_LOG_PREFIX, RETITLE_MIN_CONFIDENCE, RETITLE_MODE, RETITLE_PROMPT_VERSION, titleToCheck, type RetitleMode } from './retitle-policy';

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export async function handleTopicVerdict(
  conversation: ConversationRow,
  messages: UIMessage[],
  topic: { label: 'same_topic' | 'new_topic'; confidence: number },
  userId: string,
  deps: {
    mode?: RetitleMode;
    generate?: Parameters<typeof titleConversation>[0]['generate'];
    resolveModel?: typeof resolveChatModel;
    replace?: typeof replaceAutoTitle;
    ping?: typeof pingConversation;
    log?: (line: string, data: Record<string, unknown>) => void;
    record?: (input: DecisionLedgerInput) => Promise<string | null>;
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

  // Live mode: record verdict and optionally apply the rename
  const fingerprint = fingerprintOf({ conversationId: conversation.id, title: oldTitle, topic });
  const record = deps.record ?? recordDecision;

  if (!renames) {
    // Low confidence or same_topic: record as suggested (not applied)
    await record({
      teamId: conversation.teamId,
      workspaceId: conversation.workspaceId ?? null,
      capability: 'chat_retitle',
      fingerprint,
      promptVersion: RETITLE_PROMPT_VERSION,
      verdict: topic.label,
      confidence: topic.confidence,
      applied: false,
      status: 'suggested',
      reason: topic.confidence < RETITLE_MIN_CONFIDENCE ? 'below_threshold' : undefined,
    });
    return;
  }

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
    if (!result || result.title === oldTitle) {
      // Title generation succeeded but no change, record as applied (no-op)
      await record({
        teamId: conversation.teamId,
        workspaceId: conversation.workspaceId ?? null,
        capability: 'chat_retitle',
        fingerprint,
        promptVersion: RETITLE_PROMPT_VERSION,
        verdict: topic.label,
        confidence: topic.confidence,
        appliedAnswer: oldTitle,
        applied: false,
        status: 'suggested',
        reason: 'no_change',
      });
      return;
    }
    const titleResult = await (deps.replace ?? replaceAutoTitle)(conversation.id, oldTitle, result.title);
    if (titleResult) await (deps.ping ?? pingConversation)(conversation.id, 'title');
    // Record successful rename
    await record({
      teamId: conversation.teamId,
      workspaceId: conversation.workspaceId ?? null,
      capability: 'chat_retitle',
      fingerprint,
      promptVersion: RETITLE_PROMPT_VERSION,
      verdict: topic.label,
      confidence: topic.confidence,
      appliedAnswer: result.title,
      applied: true,
      status: 'applied',
    });
  } catch (e) {
    warn(e);
    // Record failure to apply: routing had decided to rename, but title generation failed
    await record({
      teamId: conversation.teamId,
      workspaceId: conversation.workspaceId ?? null,
      capability: 'chat_retitle',
      fingerprint,
      promptVersion: RETITLE_PROMPT_VERSION,
      verdict: topic.label,
      confidence: topic.confidence,
      applied: false,
      status: 'fallback',
      reason: 'timeout',
    });
  }
}
