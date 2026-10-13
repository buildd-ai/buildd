import type { RunnerModelAuthSource } from '@buildd/shared';

/**
 * `?state=` fixtures for Settings → Runners, so the visual audit can see every
 * model-login line a runner token row can show (docs/specs/qa-capture-steps.md).
 * Runners report the login on their heartbeat; the QA data's tokens may carry
 * none, so only "not reported" ever renders there.
 *
 * `?state=model-auth-<source>` sets that reported source on every token shown;
 * `model-auth-not_reported` clears it and marks each token seen so the line
 * renders. Display only: nothing is written.
 *
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */

export const RUNNERS_QA_STATES = [
  'model-auth-machine_login',
  'model-auth-machine_token',
  'model-auth-api_key',
  'model-auth-none',
  'model-auth-not_reported',
] as const;

export type RunnersQaState = (typeof RUNNERS_QA_STATES)[number];

export function resolveRunnersQaState(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): RunnersQaState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (RUNNERS_QA_STATES as readonly string[]).includes(value ?? '') ? (value as RunnersQaState) : null;
}

interface TokenRow {
  lastSeenAt: string | null;
  modelAuthSource: RunnerModelAuthSource | null;
}

export function withQaModelAuth<T extends TokenRow>(
  tokens: T[],
  state: RunnersQaState | null,
  now: () => string = () => new Date().toISOString(),
): T[] {
  if (!state) return tokens;
  if (state === 'model-auth-not_reported') {
    return tokens.map((t) => ({ ...t, lastSeenAt: t.lastSeenAt ?? now(), modelAuthSource: null }));
  }
  const source = state.slice('model-auth-'.length) as RunnerModelAuthSource;
  return tokens.map((t) => ({ ...t, modelAuthSource: source }));
}
