/**
 * `buildd.red_check_cause`: a PR's red check that no rule could call, judged
 * from its failing lines. Is it the environment (a flake worth a re-run) or the
 * code (worth a fix)? (surface-ia-home-missions-initiatives.md §11 R-3.)
 *
 * The rules (`apps/web/src/lib/red-check-cause.ts`) decide first and are never
 * asked again: this is only for a head whose cause they left `unknown`.
 *
 * - **Output**: `environment | code`.
 * - **Fallback**: `code`, which is what an unknown cause already reads as, so
 *   a model that cannot answer (or is unsure) leaves the card on Start fix.
 * - **Features**: per failed job (at most three) its name, failing step and
 *   failing lines, each bounded. The lines are CI log output, never the diff.
 */
import { choice } from '@buildd/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@buildd/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';

export const RED_CHECK_CAUSE_KIND = 'buildd.red_check_cause' as const;
export const RED_CHECK_CAUSE_DECISIONS = ['environment', 'code'] as const;
export type RedCheckCauseDecision = (typeof RED_CHECK_CAUSE_DECISIONS)[number];

const JOBS_MAX = 3;
const NAME_MAX = 200;
const LINES_MAX = 2_000;

export interface RedCheckCauseJob {
  name: string;
  step: string | null;
  lines: string;
}

export interface RedCheckCauseFeatures {
  jobs: RedCheckCauseJob[];
}

export function parseRedCheckCauseFeatures(input: unknown): FeatureParse<RedCheckCauseFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const jobs = (input as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, message: 'jobs must be a non-empty array' };
  const out: RedCheckCauseJob[] = [];
  for (const j of jobs.slice(0, JOBS_MAX)) {
    if (!j || typeof j !== 'object') return { ok: false, message: 'each job must be an object' };
    const { name, step, lines } = j as Record<string, unknown>;
    if (typeof name !== 'string') return { ok: false, message: 'job name must be a string' };
    if (step != null && typeof step !== 'string') return { ok: false, message: 'job step must be a string or null' };
    if (lines != null && typeof lines !== 'string') return { ok: false, message: 'job lines must be a string or null' };
    // The end of the lines is nearest the failure: keep it when they are long.
    out.push({ name: name.slice(0, NAME_MAX), step: typeof step === 'string' ? step.slice(0, NAME_MAX) : null, lines: (lines ?? '').slice(-LINES_MAX) });
  }
  if (out.every(j => !j.lines.trim())) return { ok: false, message: 'no job has failing lines to judge' };
  return { ok: true, features: { jobs: out } };
}

const questions = {
  decision: choice(
    'A pull request\'s CI check failed. Below are the failed jobs with the lines from their logs that name the failure. Did the failure come from the environment the job ran in (a network or service outage, a lost runner, a resource limit, a dependency download, a timing-dependent test), so re-running the same code would likely pass? Or does it come from the code under test (a failing assertion, a type or build error, a wrong expectation), so it needs a fix?',
    {
      environment: 'The environment failed; re-running the same code would likely pass',
      code: 'The code under test is wrong; it needs a fix',
    },
  ),
};

export const RED_CHECK_CAUSE_CONFIG: DecisionKindConfig<
  typeof RED_CHECK_CAUSE_KIND, RedCheckCauseFeatures, RedCheckCauseDecision, typeof questions
> = {
  kind: RED_CHECK_CAUSE_KIND,
  policyVersion: 'redcause-2026-10-23.a',
  featureSchemaVersion: 'redcause-features-v1',
  decisions: RED_CHECK_CAUSE_DECISIONS,
  parseFeatures: parseRedCheckCauseFeatures,
  // The rules already ran (red-check-cause.ts classifyJob); this kind is only asked when they could not call it.
  override: () => null,
  questions,
  state: (f) => ({ ...f }),
  interpret: (a) => ({ decision: a.decision.choice, confidence: a.decision.confidence, reasonCode: `cause_${a.decision.choice}` }),
  // Not yet measured on a held-out set: only a confident answer moves the card to Re-run.
  minConfidence: 0.75,
  fallback: (_f, cause) => ({ decision: 'code', reasonCode: `fallback_${cause}` }),
};

/** Opt-in: new spend, and its fallback is the card as it reads without it. Rollback: `mode: 'shadow'`. */
export const RED_CHECK_CAUSE_BINDING: BuilddDecisionKindBinding = {
  capability: 'red_check_cause',
  mode: 'live',
};

export const redCheckCauseKind = defineBuilddDecisionKind(RED_CHECK_CAUSE_CONFIG, RED_CHECK_CAUSE_BINDING);
