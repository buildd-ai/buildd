/**
 * The fixed label vocabularies of a chat retro lesson. Every text value a
 * lesson row can hold comes from one of these (or matches one of the patterns
 * below). There is no catch-all label: "nothing fits" shows up as low
 * confidence, which the gates handle (docs/design/decision-calls.md, Point 7).
 */

/** Bump when a question, a definition, the state shape or a gate changes. */
export const CHAT_RETRO_VERSION = 'cr1';

export const SATISFIED_LABELS = ['yes', 'partly', 'no'] as const;
export type SatisfiedLabel = typeof SATISFIED_LABELS[number];

export const INTENT_LABELS = ['status_check', 'find_object', 'explain', 'act', 'plan', 'configure'] as const;
export type IntentLabel = typeof INTENT_LABELS[number];

export const TURN_LABELS = [
  'needed', 'wrong_tool', 'missing_capability', 'misleading_description',
  'over_fetch', 'reasoning_timeout', 're_asked', 'wrong_tier',
] as const;
export type TurnLabel = typeof TURN_LABELS[number];
/**
 * Visible-answer causes (./visible-answer.ts). Code labels these from the
 * stored turns and the client's turn signal; the model is never asked them,
 * so they are not in TURN_LABELS.
 */
export const VISIBLE_CAUSE_LABELS = ['no_answer', 'render_gap', 'blank_retry'] as const;
export type VisibleCauseLabel = typeof VISIBLE_CAUSE_LABELS[number];

/** Every turn label but `needed` is a cause of waste, and so is every visible-answer cause. */
export type CauseLabel = Exclude<TurnLabel, 'needed'> | VisibleCauseLabel;
export const CAUSE_LABELS: readonly CauseLabel[] = [
  ...TURN_LABELS.filter((l): l is Exclude<TurnLabel, 'needed'> => l !== 'needed'),
  ...VISIBLE_CAUSE_LABELS,
];

/** The fix classes the model picks from. */
export const FIX_CLASS_LABELS = [
  'tool_description', 'tool_or_param', 'system_prompt', 'routing_tier', 'directive_or_memory', 'ui',
] as const;
/** Code-only fix class: the turn itself (stream, persistence) lost the answer. Never asked. */
export const CODE_FIX_CLASS_LABELS = ['turn_pipeline'] as const;
/** A fix class the model may pick. */
export type ModelFixClassLabel = typeof FIX_CLASS_LABELS[number];
export type FixClassLabel = ModelFixClassLabel | typeof CODE_FIX_CLASS_LABELS[number];
export const ALL_FIX_CLASS_LABELS: readonly FixClassLabel[] = [...FIX_CLASS_LABELS, ...CODE_FIX_CLASS_LABELS];

/** Waste candidates code detects. The last three are the visible-answer kinds. */
export const VISIBLE_CANDIDATE_KINDS = ['no_output', 'render_gap', 'blank_retry'] as const;
export type VisibleCandidateKind = typeof VISIBLE_CANDIDATE_KINDS[number];
export const CANDIDATE_KINDS = [
  'stopped', 'repeat_call', 'large_result', 'routing_error', 'denied_approval', 'thumbs_down',
  ...VISIBLE_CANDIDATE_KINDS,
] as const;
export type CandidateKind = typeof CANDIDATE_KINDS[number];

export const STATUS_LABELS = ['skipped', 'judged', 'failed'] as const;
export type RetroStatus = typeof STATUS_LABELS[number];

export const SKIP_REASONS = ['trivial', 'team_cap', 'state_budget', 'sensitive'] as const;
export type SkipReason = typeof SKIP_REASONS[number];

/** Decision error kinds a failed retro records (the kit's, plus `threw`). */
export const ERROR_KINDS = [
  'capability_disabled', 'missing_key', 'invalid_request', 'timeout', 'transport',
  'rate_limited', 'provider_error', 'parse', 'sdk_missing', 'uncalibrated', 'threw',
] as const;

/** A buildd tool name: the registry's identifiers, never a user value. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** `chat-retro:<cause>-<fix_class>-<tool|none>-<hash6>`. */
export const SIGNATURE_PATTERN = /^chat-retro:[a-z_]+-[a-z_]+-[a-z0-9_]+-[0-9a-f]{6}$/;
/** `cr1`, optionally `cr1|<model id>`. */
export const VERSION_PATTERN = /^cr\d+(\|[A-Za-z0-9._:/~-]{1,120})?$/;

/**
 * The allowed values of every text column of `chat_retros`, by column name.
 * Structural check: the schema test asserts every text column
 * has an entry here, and `assertContentFree` checks a row against it before
 * it is written.
 */
export const LESSON_TEXT_COLUMNS: Record<string, readonly string[] | RegExp> = {
  status: STATUS_LABELS,
  skip_reason: SKIP_REASONS,
  intent: INTENT_LABELS,
  satisfied: SATISFIED_LABELS,
  primary_cause: CAUSE_LABELS,
  fix_class: ALL_FIX_CLASS_LABELS,
  tool_name: TOOL_NAME_PATTERN,
  signature: SIGNATURE_PATTERN,
  version: VERSION_PATTERN,
  error: ERROR_KINDS,
};

/** Evidence entry keys; every value is a number, a ref id or a label. */
export const EVIDENCE_KEYS = ['turn', 'messageId', 'kind', 'tokens', 'label', 'conf'] as const;
