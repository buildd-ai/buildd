import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import type { EstimatePoint } from './EstimatesClient';

/** `?state=` values the page renders from static data, so the visual audit can capture each variant. */
export const ESTIMATES_FIXTURE_STATES = ['enabled', 'enabled-empty', 'error'] as const;
export type EstimatesFixtureState = (typeof ESTIMATES_FIXTURE_STATES)[number];

export function isEstimatesFixtureState(v: string | undefined): v is EstimatesFixtureState {
  return !!v && (ESTIMATES_FIXTURE_STATES as readonly string[]).includes(v);
}

const score = (scored: number, withinP80: number | null) => ({ n: scored, scored, withinP80, medianRatio: 1.1, medianAbsLogError: 0.25 });

export const FIXTURE_READOUT: TaskEstimateReadout = {
  estimatorVersion: 'blend-v1', rows: 40, overall: score(40, 0.85), tokens: score(40, 0.78), repairs: null,
  bySource: [{ key: 'neighbours', score: score(28, 0.9) }, { key: 'prior', score: score(12, 0.7) }],
  byKind: [{ key: 'feature', score: score(24, 0.88) }, { key: 'fix', score: score(16, 0.8) }],
  byCluster: [{ key: 'apps/web/missions', score: score(14, 0.92) }, { key: 'packages/core', score: score(10, 0.8) }],
  byHistory: [{ band: '0-4', score: score(8, 0.6) }, { band: '5+', score: score(32, 0.92) }],
  indeterminate: false,
};

export const FIXTURE_EMPTY_READOUT: TaskEstimateReadout = {
  ...FIXTURE_READOUT, rows: 0, overall: score(0, null), tokens: score(0, null),
  bySource: [], byKind: [], byCluster: [], byHistory: [], indeterminate: true,
};

export const FIXTURE_POINTS: EstimatePoint[] = [
  { estimate: 10, actual: 12, p80: 16 }, { estimate: 20, actual: 15, p80: 28 }, { estimate: 30, actual: 41, p80: 45 },
  { estimate: 45, actual: 40, p80: 70 }, { estimate: 60, actual: 95, p80: 90 }, { estimate: 90, actual: 80, p80: 130 },
  { estimate: 120, actual: 150, p80: 180 }, { estimate: 15, actual: 14, p80: 22 },
];
