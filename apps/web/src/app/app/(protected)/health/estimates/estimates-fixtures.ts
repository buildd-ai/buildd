import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';

/** `?state=` values the page renders from static data, so the visual audit can capture each variant. */
export const ESTIMATES_FIXTURE_STATES = [
  'enabled', 'enabled-empty', 'enabled-few', 'enabled-ten', 'enabled-overrun', 'enabled-underrun',
  'enabled-limited-history', 'error', 'off-admin', 'off-member',
] as const;
export type EstimatesFixtureState = (typeof ESTIMATES_FIXTURE_STATES)[number];
export type EstimatesEnabledFixtureState = Exclude<EstimatesFixtureState, 'error' | 'off-admin' | 'off-member'>;

export function isEstimatesFixtureState(v: string | undefined): v is EstimatesFixtureState {
  return !!v && (ESTIMATES_FIXTURE_STATES as readonly string[]).includes(v);
}

const score = (scored: number, withinP80: number | null, medianRatio: number | null = 1.05) =>
  ({ n: scored, scored, withinP80, medianRatio, medianAbsLogError: 0.25 });

/** A readout whose estimates all leaned on similar tasks unless `limited` of them leaned on the prior. */
function fixture(overall: ReturnType<typeof score>, limited = 0): TaskEstimateReadout {
  const n = overall.scored;
  return {
    estimatorVersion: 'blend-v1', rows: n, overall, tokens: score(n, overall.withinP80), repairs: null,
    bySource: n === 0 ? [] : [
      { key: 'neighbours', score: score(n - limited, overall.withinP80) },
      ...(limited ? [{ key: 'prior', score: score(limited, 0.5, 1.9) }] : []),
    ],
    byKind: [], byCluster: [], byHistory: [],
    indeterminate: n === 0,
  };
}

export const FIXTURE_READOUTS: Record<EstimatesEnabledFixtureState, TaskEstimateReadout> = {
  'enabled': fixture(score(40, 0.85)),
  'enabled-empty': fixture(score(0, null, null)),
  'enabled-few': fixture(score(4, 0.75)),
  'enabled-ten': fixture(score(10, 0.7)),
  'enabled-overrun': fixture(score(24, 0.5, 1.5)),
  'enabled-underrun': fixture(score(18, 0.95, 0.6)),
  'enabled-limited-history': fixture(score(32, 0.8), 6),
};
