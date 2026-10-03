/**
 * Challengers: a second route asked about a decision that was already made.
 *
 * The applied answer belongs to the caller the moment `runDecisionKind`
 * returns. A challenger runs after that (typically out of band, after the
 * response is sent) to measure another provider, model or policy against the
 * same features: did it agree, what would it have cost, how slow was it. It
 * never changes what was applied, and it never mutates the response it reads.
 *
 * A challenger that cannot run says why (`skipReason`), so a readout can tell
 * "no challenger was asked" apart from "the challenger was asked and failed".
 *
 * Agreement is not correctness. Whether either answer was right comes from an
 * outcome label attached later against the decision record.
 *
 * Imports from `./index` are used inside functions only (index re-exports
 * this module), so the cycle is safe.
 */

import { canonicalJson, shortHash } from './index';
import {
  runDecisionAttempt,
  type DecisionAttempt,
  type DecisionKind,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionRoute,
  type DecisionSource,
} from './policy';
import type { DecisionQuestions } from './index';

export type ChallengerSkip =
  /** No challenger route resolved (no key, no model configured). */
  | 'no_route'
  /** A deterministic rule decided; no model answer exists to challenge. */
  | 'deterministic_override'
  /** The kind was off for this caller. */
  | 'disabled'
  /** The applied call refused its features. */
  | 'invalid_features'
  /** The features handed to the challenger hash differently from the ones the applied answer saw. */
  | 'feature_mismatch'
  /** The caller's sampler left this subject out. */
  | 'not_sampled'
  /** The response belongs to another kind. */
  | 'wrong_kind';

export interface ChallengerRun<D extends string = string> {
  status: 'attempted' | 'skipped';
  skipReason: ChallengerSkip | null;
  /** The decision in effect, copied from the applied response. */
  appliedDecision: D;
  appliedSource: DecisionSource;
  /** The challenger's attempt, role `challenger`, never applied. Null when skipped. */
  attempt: DecisionAttempt<D> | null;
  /** Did the challenger pick the applied decision? Null when it gave no decision. */
  agrees: boolean | null;
}

export interface RunChallengerOptions {
  /** False: the subject is outside the challenger sample. Default true. */
  sampled?: boolean;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Ask `route` the same question the applied response answered. Never throws,
 * never applies, never mutates `applied`.
 */
export async function runChallenger<K extends string, F, D extends string, Q extends DecisionQuestions>(
  kind: DecisionKind<K, F, D, Q>,
  request: DecisionRequest<F>,
  applied: DecisionResponse<K, D>,
  route: DecisionRoute | null,
  opts: RunChallengerOptions = {},
): Promise<ChallengerRun<D>> {
  const base = { appliedDecision: applied.decision, appliedSource: applied.source };
  const skip = (skipReason: ChallengerSkip): ChallengerRun<D> => ({ ...base, status: 'skipped', skipReason, attempt: null, agrees: null });

  if (applied.kind !== kind.kind) return skip('wrong_kind');
  if (applied.deterministicOverride || applied.source === 'rule') return skip('deterministic_override');
  if (applied.mode === 'disabled') return skip('disabled');
  if (applied.featureDigest === null) return skip('invalid_features');
  if (opts.sampled === false) return skip('not_sampled');
  if (!route) return skip('no_route');

  let features: F;
  try {
    const parsed = kind.parseFeatures(request.features);
    if (!parsed.ok) return skip('invalid_features');
    features = parsed.features;
    if (shortHash(canonicalJson(features)) !== applied.featureDigest) return skip('feature_mismatch');
  } catch {
    return skip('invalid_features');
  }

  const attempt = await runDecisionAttempt(kind, route, features, {
    role: 'challenger',
    index: applied.attempts.length,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    ...base,
    status: 'attempted',
    skipReason: null,
    attempt,
    agrees: attempt.decision === null ? null : attempt.decision === applied.decision,
  };
}
