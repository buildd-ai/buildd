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

/**
 * Eval cases for the reviewer's remedy doctrine (`buildd.reviewer.remedy_doctrine`,
 * `REVIEWER_REMEDY_PROMPT_VERSION`). Agent-side text has no model-scored set, so a
 * case is the reviewer's context plus the structured finding a correct review
 * returns; `reviewer-remedy.test.ts` checks that finding against the validator.
 * Fictional throughout: no production identifiers.
 */
export const REVIEWER_REMEDY_EVAL_CASES = [
  {
    id: 'infeasible-claim-contradicts-pinned-criterion',
    promptId: 'buildd.reviewer.remedy_doctrine',
    context: {
      pinnedCriterion: 'R-17: every model call goes through the platform broker and coordinator.',
      builderClaim: 'The sandbox has no database, so the copy eval cannot run here.',
      resolveCapability: 'model.inference: available via request_capability',
    },
    /** What a person-run remedy would look like: must be rejected. */
    badFinding: {
      title: 'A person must run `eval:copy --network --team <id>` with a DB, or waive it',
      remedyClass: 'operational_run',
      remedyEvidence: { resolveCapabilityResult: 'model.inference: available via request_capability', contradictsPinnedCriterion: true, existingCapabilityCovers: true },
    },
    /** The restated finding: names the capability, sends no one to run with a DB. */
    expectedFinding: {
      title: 'Use request_capability model.inference for the eval calls instead of a direct network run',
      remedyClass: 'capability_gap',
      remedyEvidence: { resolveCapabilityResult: 'model.inference: available via request_capability', contradictsPinnedCriterion: true, existingCapabilityCovers: true, capability: 'model.inference' },
    },
  },
  {
    // Living Spec fa62b865 §11.1 (the #5727 shape): a screen-named criterion with no comparison is
    // evidence buildd captures, not a request to the author for screenshots.
    id: 'design-comparison-is-evidence-not-builder-work',
    promptId: 'buildd.reviewer.remedy_doctrine',
    context: {
      pinnedCriterion: 'AC-9: the activity row matches design screen phone-row.\n  - screen: phone-row',
      builderClaim: 'The row matches the design.',
      resolveCapability: 'visual capture: buildd dispatches it',
    },
    /** Asks the author for shots: a round the author cannot satisfy. */
    badFinding: {
      title: 'Attach screenshots of the real route beside design screen phone-row',
      path: 'apps/web/src/components/Row.tsx',
    },
    expectedFinding: {
      title: 'Compare AC-9 screen phone-row with the built page',
      remedyClass: 'evidence',
      evidence: { criterionId: 'AC-9', screen: 'phone-row', route: '/app/activity' },
    },
  },
] as const;

export function promptSurface(id: string): PromptSurface {
  if (CHAT_PROMPT_IDS.includes(id)) return 'chat';
  if (DECISION_PROMPT_IDS.includes(id)) return 'decision';
  if (Object.values(SETS).some(s => s.promptId === id)) return 'decision';
  return 'other';
}
