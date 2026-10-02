/**
 * The chat turn's directive hook (knowledge-base: buildd/design/memory-done-right.md, "Chat").
 * Two jobs, both behind `TurnDeps.directives` so the turn builder carries one
 * seam and no directive logic of its own:
 *
 *  - load: the person's standing rules, rendered into the turn's instructions
 *    (core `renderStandingRules`: capped, newest first, truncation counted);
 *  - propose: when the user message states a rule, a confirm card. Jev's chat
 *    tier decides when it answers confidently; otherwise the keyword rule does
 *    (fail open). Jev is only asked when the message carries a rule cue, so an
 *    ordinary turn costs nothing extra. The card rides the turn's own stream
 *    as a data part just before `finish`, and is saved with the message.
 *
 * Nothing here can fail a turn: every path resolves, at worst to "no card".
 */
import type { UIMessageChunk } from 'ai';
import {
  keywordDirective,
  mentionsRule,
  proposeDirective,
  type ChatDirectiveJudgement,
  type StandingRule,
} from '@buildd/core/chat-directives';
import { CHAT_DIRECTIVE_PART_TYPE, type ChatDirectiveCandidateData, type ChatMessagePart } from '@buildd/shared';

/** Outer bound on the proposal: the decider's own deadline plus slack. A turn never waits longer at its end. */
export const DIRECTIVE_PROPOSAL_BUDGET_MS = 6_000;

export interface DirectiveWorkspace { id: string; name: string; hint?: string | null }

export interface ChatDirectiveHooks {
  /** The person's rules. Empty on failure. */
  load: () => Promise<StandingRule[]>;
  /** Jev's answers, or null (no key, disabled). Must not throw. */
  judge?: (input: {
    message: string;
    previous: string | null;
    workspace: DirectiveWorkspace | null;
    rule: boolean;
  }) => Promise<ChatDirectiveJudgement | null>;
}

/**
 * The card for this user message, or null. Resolves, never rejects, within
 * DIRECTIVE_PROPOSAL_BUDGET_MS (a slow Jev falls back to the keyword rule).
 */
export async function proposeDirectiveCard(input: {
  conversationId: string;
  message: string;
  previous?: string | null;
  workspace: DirectiveWorkspace | null;
  judge?: ChatDirectiveHooks['judge'];
  budgetMs?: number;
}): Promise<ChatDirectiveCandidateData | null> {
  try {
    if (!mentionsRule(input.message)) return null;
    const rule = keywordDirective(input.message);
    let judgement: ChatDirectiveJudgement | null = null;
    if (input.judge) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), input.budgetMs ?? DIRECTIVE_PROPOSAL_BUDGET_MS); });
      judgement = await Promise.race([
        input.judge({ message: input.message, previous: input.previous ?? null, workspace: input.workspace, rule }).catch(() => null),
        late,
      ]).finally(() => clearTimeout(timer));
    }
    const ws = input.workspace ? { id: input.workspace.id, name: input.workspace.name } : null;
    const p = proposeDirective({ message: input.message, workspace: ws, judgement });
    if (!p) return null;
    return { conversationId: input.conversationId, text: p.text, suggestedScope: p.suggestedScope, workspace: ws, source: p.source };
  } catch {
    return null;
  }
}

export function directivePart(data: ChatDirectiveCandidateData): ChatMessagePart {
  return { type: CHAT_DIRECTIVE_PART_TYPE, data };
}

/**
 * The turn's UI stream with the card inserted just before `finish`, so the
 * client that sent the message sees it land under the reply. No card: the
 * stream passes through untouched.
 */
export function withDirectiveCard<C extends UIMessageChunk>(
  stream: ReadableStream<C>,
  card: Promise<ChatDirectiveCandidateData | null> | null,
): ReadableStream<C> {
  if (!card) return stream;
  let sent = false;
  const emit = async (controller: TransformStreamDefaultController<C>) => {
    if (sent) return;
    sent = true;
    const data = await card.catch(() => null);
    if (data) controller.enqueue({ type: CHAT_DIRECTIVE_PART_TYPE, data } as unknown as C);
  };
  return stream.pipeThrough(new TransformStream<C, C>({
    async transform(chunk, controller) {
      if ((chunk as { type?: string }).type === 'finish') await emit(controller);
      controller.enqueue(chunk);
    },
    async flush(controller) {
      // A stream that ended without `finish` (aborted) still gets its card.
      await emit(controller);
    },
  }));
}
