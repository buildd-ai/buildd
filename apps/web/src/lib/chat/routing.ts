/**
 * Per-turn tier and intent routing through a decision call
 * (docs/design/agent-chat.md → Models: tiers; docs/design/decision-calls.md).
 *
 * A decision call is only ever an accelerator in front of a fixed default: any
 * failure (disabled, no key, timeout, parse) or low confidence takes the safe
 * default — `standard` tier with the full read-plus-approval tool set. Routing
 * can pick a cheaper tier for a turn; it never changes which model backs one.
 */

import { gateChoice, type ChoiceQuestion, type DecisionResult, decisionCall } from '@buildd/core/decision-client';
import type { ChatTier } from './models';

export const CHAT_ROUTING_QUESTIONS = {
  complexity: {
    type: 'choice',
    instructions: {
      question: 'How demanding is answering the latest user message in `turn.message`, given `turn.previous`?',
      rule: 'Follow the definitions. Length alone does not make a message complex.',
    },
    criteria: {
      simple: 'A greeting, thanks, a yes/no confirmation, or a one-fact lookup ("what\'s the status of X?") that needs no reasoning over several items.',
      standard: 'A normal question about work in flight, a summary of a few missions or tasks, or drafting one mission from a goal already discussed.',
      complex: 'Planning or comparing across many missions, tasks or trade-offs; shaping an ambiguous goal into criteria; or reasoning that must weigh conflicting evidence.',
    },
  } satisfies ChoiceQuestion<'simple' | 'standard' | 'complex'>,
  intent: {
    type: 'choice',
    instructions: {
      question: 'What does the user want done with the latest message in `turn.message`?',
      rule: 'Choose file_work only when the user asks to create, file, start or schedule something now.',
    },
    criteria: {
      answer: 'Conversation that needs no buildd data: thanks, a clarification about what was just said, general advice.',
      needs_tools: 'A question answered from live buildd state: tasks, missions, schedules, artifacts, what is running or shipped.',
      file_work: 'A request to create or file work now: "make this a mission", "file it", "start a mission for…".',
    },
  } satisfies ChoiceQuestion<'answer' | 'needs_tools' | 'file_work'>,
};

/** Thresholds live next to the questions; retuning one is a reviewed change. */
export const TIER_MIN_CONFIDENCE = 0.8;
/** Only used to *withhold* write tools, so it's gated high. */
export const INTENT_MIN_CONFIDENCE = 0.9;
/**
 * Routing sits in front of the first token (target: under 2s at p50), so its
 * deadline is tight; a slow decision just means the default tier.
 */
export const ROUTING_TIMEOUT_MS = 900;
export const FALLBACK_TIER: ChatTier = 'standard';

const TIER_FOR: Record<'simple' | 'standard' | 'complex', ChatTier> = {
  simple: 'budget', standard: 'standard', complex: 'premium',
};

export interface TurnRoute {
  tier: ChatTier;
  /** Load manage_missions create at all this turn. */
  allowWrites: boolean;
  source: 'decision' | 'fallback';
}

type Decide = (p: Parameters<typeof decisionCall<typeof CHAT_ROUTING_QUESTIONS>>[0])
  => Promise<DecisionResult<typeof CHAT_ROUTING_QUESTIONS>>;

export async function routeTurn(
  input: { teamId: string; workspaceId: string | null; userId: string; message: string; previous?: string },
  deps: { decide?: Decide } = {},
): Promise<TurnRoute> {
  const fallback: TurnRoute = { tier: FALLBACK_TIER, allowWrites: true, source: 'fallback' };
  const decide = deps.decide ?? decisionCall<typeof CHAT_ROUTING_QUESTIONS>;
  let res: DecisionResult<typeof CHAT_ROUTING_QUESTIONS>;
  try {
    res = await decide({
      capability: 'chat',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      state: { turn: { message: input.message.slice(0, 2000), previous: (input.previous ?? '').slice(0, 1000) } },
      questions: CHAT_ROUTING_QUESTIONS,
      timeoutMs: ROUTING_TIMEOUT_MS,
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;

  const tierGate = gateChoice(res.answers.complexity, TIER_MIN_CONFIDENCE);
  const intentGate = gateChoice(res.answers.intent, INTENT_MIN_CONFIDENCE);
  return {
    tier: tierGate.apply ? TIER_FOR[tierGate.label] : FALLBACK_TIER,
    // Withhold the write tools only on a confident "not filing work"; low
    // confidence keeps them (the approval card is the backstop either way).
    allowWrites: !(intentGate.apply && intentGate.label !== 'file_work'),
    source: tierGate.apply || intentGate.apply ? 'decision' : 'fallback',
  };
}
