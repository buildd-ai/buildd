/**
 * Which cloud-runner container class a workspace's tasks get
 * (`gitConfig.runnerSize`, packages/shared/src/runner-size.ts).
 *
 * An explicit `gitConfig.runnerSize` always wins. Otherwise the size is
 * derived from the workspace's recent cloud run reports (the
 * `cloud-run-report:<workerId>` artifacts, apps/cloud-runner/src/run-report.ts):
 * `large` when any of them shows
 *  - memory: a working-set peak within ~10% of the class memory;
 *  - disk: minimum free disk under ~3 GB;
 *  - a restart: the container stopped under the run (not a deploy, which
 *    restarts the agent, and not a question, which parks the run);
 *  - checkout: the warm checkout plus its dependency cache over a few GB.
 * The first derivation is stored (`gitConfig.runnerSizeDerived`) and wins
 * from then on, so one light run does not move a workspace back.
 *
 * Pure: the reports and the config come in, the decision goes out.
 * runner-size-store.ts does the reading and the one write.
 */
import { isRunnerSize, isRunnerSizeReason, type RunnerSize, type RunnerSizeReason, type RunnerSizeSource } from '@buildd/shared';

const GIB = 1024 ** 3;

/** Memory of the standard class (standard-1), used when a report carries no measured limit. */
export const STANDARD_MEMORY_BYTES = 4 * GIB;
/** Memory per Cloudflare instance type, for a report without a measured limit. */
const INSTANCE_MEMORY_BYTES: Record<string, number> = {
  'standard-1': STANDARD_MEMORY_BYTES,
  'standard-2': 6 * GIB,
  'standard-3': 8 * GIB,
  'standard-4': 12 * GIB,
};
/** Working set at or above this share of the class memory is pressure. */
export const MEMORY_PRESSURE_RATIO = 0.9;
/** Minimum free disk under this is a trigger. */
export const LOW_DISK_TRIGGER_BYTES = 3e9;
/** Warm checkout plus dependency cache over this is a trigger. */
export const CHECKOUT_TRIGGER_BYTES = 4e9;
/** How many of the newest reports the rule reads. */
export const RECENT_REPORTS = 20;

export interface RunnerSizeDecision {
  size: RunnerSize;
  source: RunnerSizeSource;
  /** Why it is `large` when derived; null otherwise. */
  reason: RunnerSizeReason | null;
  /** A fresh derivation the caller should store as `gitConfig.runnerSizeDerived`. */
  persist?: RunnerSizeDerived;
}

export interface RunnerSizeDerived {
  size: 'large';
  reason: RunnerSizeReason;
  at: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/** The first trigger one run report shows, or null. Anything malformed shows none. */
export function runnerSizeTrigger(report: unknown): RunnerSizeReason | null {
  const r = obj(report);
  const res = obj(r.resources);

  const peak = num(res.memoryPeakBytes);
  const limit = num(res.memoryLimitBytes) || INSTANCE_MEMORY_BYTES[String(r.instanceType)] || null;
  if (peak !== null && limit && peak >= limit * MEMORY_PRESSURE_RATIO) return 'memory_pressure';

  const diskFree = num(res.diskFreeMinBytes);
  if (diskFree !== null && diskFree < LOW_DISK_TRIGGER_BYTES) return 'low_disk';

  // Only `container_stopped`: the container died under a live run (OOM, a
  // platform stop). `agent_restart` (a deploy) and `question` (a park while
  // waiting for input) are not the repo's fault.
  if (r.interruption === 'container_stopped') return 'container_restart';

  const repo = obj(r.repo);
  const bytes = obj(repo.bytes);
  const skipped = obj(repo.cacheSkipped);
  const cache = Math.max(num(bytes.cacheRaw) ?? 0, num(bytes.cache) ?? 0, num(skipped.bytes) ?? 0);
  if ((num(bytes.warmRepo) ?? 0) + cache > CHECKOUT_TRIGGER_BYTES) return 'large_checkout';

  return null;
}

function storedDerivation(v: unknown): RunnerSizeDerived | null {
  const d = obj(v);
  return d.size === 'large' && isRunnerSizeReason(d.reason)
    ? { size: 'large', reason: d.reason, at: typeof d.at === 'string' ? d.at : '' }
    : null;
}

/**
 * The effective size. `reports` newest first (only the first RECENT_REPORTS
 * are read). `persist` is set only for a derivation not yet stored.
 */
export function resolveRunnerSize(input: { gitConfig: unknown; reports: readonly unknown[]; now?: Date }): RunnerSizeDecision {
  const gc = obj(input.gitConfig);
  if (isRunnerSize(gc.runnerSize)) return { size: gc.runnerSize, source: 'explicit', reason: null };

  const sticky = storedDerivation(gc.runnerSizeDerived);
  if (sticky) return { size: 'large', source: 'derived', reason: sticky.reason };

  for (const report of input.reports.slice(0, RECENT_REPORTS)) {
    const reason = runnerSizeTrigger(report);
    if (reason) {
      return {
        size: 'large', source: 'derived', reason,
        persist: { size: 'large', reason, at: (input.now ?? new Date()).toISOString() },
      };
    }
  }
  return { size: 'standard', source: 'default', reason: null };
}

/** One sentence for the settings page. */
export function describeRunnerSizeReason(reason: RunnerSizeReason): string {
  switch (reason) {
    case 'memory_pressure': return 'A recent run used nearly all of the standard memory.';
    case 'low_disk': return 'A recent run came close to filling the standard disk.';
    case 'container_restart': return 'A recent run lost its container partway through.';
    case 'large_checkout': return 'The checkout and its dependency cache are several GB.';
  }
}
