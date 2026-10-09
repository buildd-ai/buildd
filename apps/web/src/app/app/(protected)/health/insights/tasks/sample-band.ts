/**
 * `?state=sample|large` for /app/health/insights/tasks: a synthetic band
 * selection, so the visual audit can see a populated drill-down when the CI QA
 * account has no tasks in any band (docs/specs/qa-capture-steps.md). Dev server
 * only; production ignores the param. `sample` is a typical band, `large` one
 * holding hundreds of rows. `&band=<key>` picks the label; default Released.
 * The rows go through the real list and delivery projection, never the DB,
 * and nothing writes.
 */
import { BAND_LABEL, type BandKey } from '@/components/insights/flow-chart-model';
import type { BandTaskInput } from './band-rows';

export type BandDrillQaState = 'sample' | 'large';
const QA_STATES: readonly BandDrillQaState[] = ['sample', 'large'];

export function resolveBandDrillQaState(raw: string | string[] | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): BandDrillQaState | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (QA_STATES as readonly string[]).includes(value ?? '') ? (value as BandDrillQaState) : null;
}

const H = 3_600_000;
const DAY = 24 * H;
const TITLES = [
  'feat: add retry budget to the claim loop',
  'fix: keep the selection label on narrow screens',
  'refactor: move release gating into one module',
  'fix(runner): requeue an orphaned attempt after restart',
  'feat(missions): show the next step on the board',
  'chore: bump dependencies',
  'docs: explain the band chart legend',
  'review: release PR',
  'fix: empty state copy for filtered lists',
  'feat(insights): token totals per role',
];
const MISSIONS = ['Faster releases', 'Mobile polish', null, null];

/** Deterministic pseudo-random so screenshots are stable run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function sampleId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function sampleBandSelection(state: BandDrillQaState, rawBand: string | undefined, now = Date.now()): { label: string; tasks: BandTaskInput[] } {
  const band: BandKey = rawBand && Object.hasOwn(BAND_LABEL, rawBand) ? (rawBand as BandKey) : 'released';
  const span = state === 'large' ? 30 * DAY : 7 * DAY;
  const count = state === 'large' ? 340 : 14;
  const from = now - span;
  const r = rng(state === 'large' ? 7 : 3);
  const tasks: BandTaskInput[] = [];
  for (let n = 0; n < count; n++) {
    const updated = now - r() * (span - H);
    const roll = r();
    const status = roll < 0.08 ? 'failed' : roll < 0.14 ? 'in_progress' : 'completed';
    const withPr = status !== 'failed' && r() < 0.7;
    const mi = Math.floor(r() * MISSIONS.length);
    const prUrl = withPr ? `https://github.com/example/sample/pull/${1000 + n}` : null;
    tasks.push({
      id: sampleId(n + 1),
      title: `${TITLES[n % TITLES.length]} (${n + 1})`,
      status,
      updatedAt: new Date(updated).toISOString(),
      missionTitle: MISSIONS[mi],
      workers: [{
        status: status === 'in_progress' ? 'running' : status,
        prUrl,
        prNumber: withPr ? 1000 + n : null,
        mergedAt: withPr && status === 'completed' ? new Date(updated) : null,
        prLifecycleStatus: withPr ? (status === 'completed' ? 'merged' : 'pr_open') : null,
      }],
    });
  }
  return {
    label: `${BAND_LABEL[band]} · ${new Date(from).toLocaleString()} – ${new Date(now).toLocaleString()}`,
    tasks,
  };
}
