/**
 * The route a runner's model calls take, and where its credential comes from,
 * for the runner detail (Living Spec "Runner capacity: personal and team
 * usage", R-11, AC-8).
 *
 * Read from what the runner itself reported on its heartbeat, never from a
 * task's requested backend or from stored credentials: Health is not a
 * capability broker. Only a label travels, never a secret. Local login
 * readiness is one signal here; whether a team API key is available is a
 * separate, server-side eligibility signal this view does not claim to know.
 *
 * Client-safe: imported by a client component, so no DB.
 */

import type { RunnerCodexAuthSource, RunnerModelAuthSource } from '@buildd/shared';

export type RouteState = 'ready' | 'unavailable' | 'unknown';

export interface RunnerRouteRow {
  label: string;
  /** Credential type/source in plain words. */
  source: string;
  /** ready = reported usable; unavailable = reported absent; unknown = never reported. */
  state: RouteState;
}

export interface RunnerRouteInput {
  modelAuthSource?: RunnerModelAuthSource | null;
  codexAuthSource?: RunnerCodexAuthSource | null;
  /**
   * How this runner's recent runs were actually charged (`workers.costBasis`,
   * reported by whoever picked the credential). The recorded route: it is what
   * happened, whichever of a local login or a task-selected team key was used.
   */
  recentCostBasis?: readonly (RecordedBasis | null)[] | null;
}

type RecordedBasis = 'real' | 'virtual' | 'mixed' | 'unknown';

/**
 * What recent runs on this runner were charged to, read from the record and
 * never inferred from the local login (a team key can serve a task on a
 * machine that has a plan login). Hidden when nothing has been recorded.
 */
export function recordedRouteRow(bases: readonly (RecordedBasis | null)[] | null | undefined): RunnerRouteRow | null {
  const known = new Set((bases ?? []).filter((b): b is Exclude<RecordedBasis, 'unknown'> => !!b && b !== 'unknown'));
  if (known.size === 0) return null;
  const real = known.has('real') || known.has('mixed');
  const virtual = known.has('virtual') || known.has('mixed');
  const source = real && virtual ? 'Recent runs: some billed per token, some from a plan allowance'
    : real ? 'Recent runs: billed per token' : 'Recent runs: drawn from a plan allowance';
  return { label: 'Charged to', source, state: 'ready' };
}

export function claudeRouteRow(source: RunnerModelAuthSource | null | undefined): RunnerRouteRow {
  switch (source) {
    case 'machine_login': return { label: 'Claude', source: "This machine's Claude login (plan, not billed per token)", state: 'ready' };
    case 'machine_token': return { label: 'Claude', source: 'A Claude token set on this machine (plan, not billed per token)', state: 'ready' };
    case 'api_key': return { label: 'Claude', source: 'An API key on this machine (billed per token)', state: 'ready' };
    case 'none': return { label: 'Claude', source: 'No local login or key', state: 'unavailable' };
    default: return { label: 'Claude', source: 'Not reported by this runner', state: 'unknown' };
  }
}

/** Codex is optional: not reported and `none` both read as not set up, but `none` is a report. */
export function codexRouteRow(source: RunnerCodexAuthSource | null | undefined): RunnerRouteRow {
  switch (source) {
    case 'machine_login': return { label: 'Codex', source: "This machine's Codex login", state: 'ready' };
    case 'api_key': return { label: 'Codex', source: 'An OpenAI API key on this machine (billed per token)', state: 'ready' };
    case 'none': return { label: 'Codex', source: 'No local login or key', state: 'unavailable' };
    default: return { label: 'Codex', source: 'Not reported by this runner', state: 'unknown' };
  }
}

export interface RunnerRouteDetail {
  rows: RunnerRouteRow[];
  /** Why this is only the local half of the picture. */
  note: string;
}

export function runnerRouteDetail(hb: RunnerRouteInput): RunnerRouteDetail {
  const recorded = recordedRouteRow(hb.recentCostBasis);
  return {
    rows: [claudeRouteRow(hb.modelAuthSource), codexRouteRow(hb.codexAuthSource), ...(recorded ? [recorded] : [])],
    note: "Login rows are what the runner reported on its last check-in. A team API key or gateway is chosen per task: \"Charged to\" is what recent runs recorded, not a claim about what the next run will use.",
  };
}
