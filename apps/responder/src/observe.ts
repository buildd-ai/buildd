/**
 * Gather one snapshot from the black-box inputs.
 *
 * ── Everything here is best-effort ──────────────────────────────────────────
 * Each input either produces a value or produces an explicit absence. Nothing
 * here throws, and nothing here fabricates an empty value to stand in for a
 * failed read: a detector must be able to tell "the queue is empty" from "I
 * could not ask", and `cronRuns: null` is how that distinction survives into
 * the verdict.
 *
 * ── An input the operator did not configure is also null ────────────────────
 * Not an error. A responder watching a platform with no runner on the same
 * host still watches the platform; the runner probe is simply absent, and the
 * page says so by omission rather than by a false negative.
 */

import { sampleClaimEndpoint } from './probes/claim-probe';
import { neonQueryFn, readCronRuns } from './probes/cron-runs-feed';
import { sampleVersionEndpoint } from './probes/version-probe';
import { recordSample, type ResponderState } from './evidence';
import type { ResponderConfig } from './config';
import type { CronRunRow, Snapshot } from './types';

/**
 * How much `cron_runs` history to pull.
 *
 * Wide enough to cover the dispatch-stall detector's needs with room to spare
 * — it walks a streak of hourly runs, and a 24-hour read shows a full night,
 * which is the shape of the incident. The row cap is a bound on a query
 * against production, not a tuning parameter.
 */
const CRON_RUNS_LOOKBACK_HOURS = 24;
const CRON_RUNS_ROW_CAP = 500;

export interface ObserveResult {
  snapshot: Snapshot;
  /** State with this cycle's claim sample folded in. */
  state: ResponderState;
}

export async function observe(
  config: ResponderConfig,
  state: ResponderState,
  now: number,
): Promise<ObserveResult> {
  const at = new Date(now).toISOString();

  // The claim probe first and always: it is the one input that exercises the
  // path that actually broke.
  const sample = await sampleClaimEndpoint(config.appUrl, config.apiKey, { now: () => Date.now() });
  const nextState = recordSample(state, sample, now, config.sampleRetentionHours);

  const [appVersion, runnerVersion, cron] = await Promise.all([
    sampleVersionEndpoint(config.appUrl).catch(() => null),
    config.runnerUrl
      ? sampleVersionEndpoint(config.runnerUrl, { token: config.runnerToken }).catch(() => null)
      : Promise.resolve(null),
    readCronRunsSafely(config, now),
  ]);

  return {
    snapshot: {
      at,
      claimSamples: nextState.samples,
      cronRuns: cron.rows,
      ...(cron.error ? { cronRunsError: cron.error } : {}),
      appVersion,
      runnerVersion,
      samplingSince: nextState.samplingSince,
    },
    state: nextState,
  };
}

async function readCronRunsSafely(
  config: ResponderConfig,
  now: number,
): Promise<{ rows: CronRunRow[] | null; error?: string }> {
  if (!config.cronRunsUrl) {
    return { rows: null, error: 'BUILDD_RESPONDER_CRON_RUNS_URL is not configured' };
  }
  try {
    const query = await neonQueryFn(config.cronRunsUrl);
    const sinceIso = new Date(now - CRON_RUNS_LOOKBACK_HOURS * 3_600_000).toISOString();
    return { rows: await readCronRuns(query, { sinceIso, limit: CRON_RUNS_ROW_CAP }) };
  } catch (err) {
    return { rows: null, error: err instanceof Error ? err.message : String(err) };
  }
}
