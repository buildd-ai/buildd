/**
 * Which production surface serves a prompt id, so the eval scores (or, for an
 * id with no eval set, records) it with the model that surface runs:
 *
 *   - `decision`: read by a decision call (`@buildd/core/decision-client`).
 *     Production resolves the team's `decision_model` (default Jev,
 *     `DEFAULT_DECISION_MODEL`) through `resolveDecisionRoute`.
 *   - `chat`: the chat turn's system prompt. Production resolves the chat
 *     tier's model through the tier registry, surface `chat`
 *     (`apps/web/src/lib/chat/models.ts`), at the fallback tier a turn starts
 *     on (`FALLBACK_TIER`).
 *   - `other`: agent-side text (roles, reviewer, mission prompts) that runs on
 *     whatever model the task routes to. No single production model; no eval.
 *
 * Every benchmark set calls `decisionCall`, so a set's prompt id is always a
 * decision prompt. Ids are literals so this module stays import-light;
 * `surfaces.test.ts` checks each one against its module's constant.
 */
import { SETS } from './benchmark-sets';

export type PromptSurface = 'decision' | 'chat' | 'other';

/** Decision prompts with no benchmark set yet. */
export const DECISION_PROMPT_IDS: readonly string[] = [
  'buildd.chat_routing',
  'buildd.chat_title_topic',
  'buildd.chat_retro.questions',
  'buildd.mission_strand_choice',
  'buildd.surface_audit_advice',
  'buildd.goal_quality.questions',
  'buildd.endpoint_model_suggest',
];

export const CHAT_PROMPT_IDS: readonly string[] = ['buildd.chat_instructions'];

export function promptSurface(id: string): PromptSurface {
  if (CHAT_PROMPT_IDS.includes(id)) return 'chat';
  if (DECISION_PROMPT_IDS.includes(id)) return 'decision';
  if (Object.values(SETS).some(s => s.promptId === id)) return 'decision';
  return 'other';
}
