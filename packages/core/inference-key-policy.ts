/**
 * Whose provider key a person's chat turn spends (`teams.inferenceKeyPolicy`).
 * Pure, so API routes and client code can validate it without the DB. The
 * resolver in `inference-keys.ts` enforces it.
 *
 * - `team`: the team key pays for everyone; a person's own key is ignored.
 * - `team_or_own`: the team key, and a person may use their own instead.
 * - `own`: everyone brings their own key; no team fallback for chat.
 */
export type InferenceKeyPolicy = 'team' | 'team_or_own' | 'own';

export const INFERENCE_KEY_POLICIES: readonly InferenceKeyPolicy[] = ['team', 'team_or_own', 'own'];

export function isInferenceKeyPolicy(value: unknown): value is InferenceKeyPolicy {
  return typeof value === 'string' && (INFERENCE_KEY_POLICIES as readonly string[]).includes(value);
}

/** May a person store and use their own key under this policy? */
export function policyAllowsOwnKey(policy: InferenceKeyPolicy): boolean {
  return policy !== 'team';
}
