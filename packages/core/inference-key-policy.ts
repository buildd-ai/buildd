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

/**
 * The one team credential policy (`teams.credentialPolicy`), which will govern
 * agent runs as well as chat and inference, for every provider:
 *
 * - `team`: team keys only; a person's own key is ignored.
 * - `personal_first`: the requesting person's own key, else the team's.
 * - `personal_only`: no team key at all.
 *
 * It replaces `inferenceKeyPolicy` one-to-one. Until that column is dropped,
 * read a team row through `effectiveKeyPolicy`, which prefers the new column
 * and falls back to the old one, and write both (`policyColumns`).
 */
export type CredentialPolicy = 'team' | 'personal_first' | 'personal_only';

export const CREDENTIAL_POLICIES: readonly CredentialPolicy[] = ['team', 'personal_first', 'personal_only'];

export function isCredentialPolicy(value: unknown): value is CredentialPolicy {
  return typeof value === 'string' && (CREDENTIAL_POLICIES as readonly string[]).includes(value);
}

const TO_CREDENTIAL: Record<InferenceKeyPolicy, CredentialPolicy> = {
  team: 'team',
  team_or_own: 'personal_first',
  own: 'personal_only',
};

const TO_INFERENCE: Record<CredentialPolicy, InferenceKeyPolicy> = {
  team: 'team',
  personal_first: 'team_or_own',
  personal_only: 'own',
};

export function toCredentialPolicy(policy: InferenceKeyPolicy): CredentialPolicy {
  return TO_CREDENTIAL[policy];
}

export function toInferenceKeyPolicy(policy: CredentialPolicy): InferenceKeyPolicy {
  return TO_INFERENCE[policy];
}

/**
 * A team row's policy in the legacy vocabulary the resolvers still speak.
 * `null` when neither column holds a known value — each caller keeps its own
 * fallback for that, as before.
 */
export function effectiveKeyPolicy(row: { credentialPolicy?: unknown; inferenceKeyPolicy?: unknown } | null | undefined): InferenceKeyPolicy | null {
  if (!row) return null;
  if (isCredentialPolicy(row.credentialPolicy)) return toInferenceKeyPolicy(row.credentialPolicy);
  if (isInferenceKeyPolicy(row.inferenceKeyPolicy)) return row.inferenceKeyPolicy;
  return null;
}

/** The team columns to write for a policy given in either vocabulary. */
export function policyColumns(policy: InferenceKeyPolicy | CredentialPolicy): { credentialPolicy: CredentialPolicy; inferenceKeyPolicy: InferenceKeyPolicy } {
  const credentialPolicy = isCredentialPolicy(policy) ? policy : toCredentialPolicy(policy);
  return { credentialPolicy, inferenceKeyPolicy: toInferenceKeyPolicy(credentialPolicy) };
}
