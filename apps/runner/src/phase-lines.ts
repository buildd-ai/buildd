/**
 * Machine-readable phase markers for a supervisor that only sees stdout.
 *
 * In a cloud container (BUILDD_EXECUTOR=cloud) the runner prints, on its own
 * line, `BUILDD_PHASE=<phase> <epoch ms>` at the start and end of the clone
 * and of the runner's own dependency install, and of the warm-repo steps
 * (restore, the post-restore fetch, the snapshot upload; warm-repo.ts).
 * Alongside them: `BUILDD_METRIC=<name> <integer>` for byte counts and ages,
 * and `BUILDD_REPO_SOURCE=warm` or `BUILDD_REPO_SOURCE=clone <reason>` saying
 * how the repo got onto the disk. apps/cloud-runner reads all three into its
 * per-run report (src/run-report.ts parses the same formats; a test there
 * keeps the two in step). Nothing else is printed: no paths, no URLs.
 *
 * Off everywhere else, so a long-lived runner's log is unchanged.
 */

export const PHASE_LINE_PREFIX = 'BUILDD_PHASE=';

export const RUN_PHASES = [
  'clone_start', 'clone_end', 'install_start', 'install_end',
  'restore_warm_start', 'restore_warm_end', 'fetch_start', 'fetch_end',
  'warm_upload_start', 'warm_upload_end',
] as const;
export type RunPhase = typeof RUN_PHASES[number];

export const METRIC_LINE_PREFIX = 'BUILDD_METRIC=';
export const RUN_METRICS = ['clone_bytes', 'restore_bytes', 'fetch_bytes', 'cache_bytes', 'snapshot_age_ms', 'warm_upload_bytes'] as const;
export type RunMetric = typeof RUN_METRICS[number];

export const REPO_SOURCE_LINE_PREFIX = 'BUILDD_REPO_SOURCE=';
/** Why the repo was cloned rather than restored from a warm snapshot. */
export const REPO_FALLBACK_REASONS = ['disabled', 'no_snapshot', 'unavailable', 'disk', 'restore_failed'] as const;
export type RepoFallbackReason = typeof REPO_FALLBACK_REASONS[number];
export type RepoSource = 'warm' | 'clone';

export function formatMetricLine(name: RunMetric, value: number): string {
  const v = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${METRIC_LINE_PREFIX}${name} ${v}`;
}

export function formatRepoSourceLine(source: RepoSource, reason?: RepoFallbackReason): string {
  return source === 'warm' ? `${REPO_SOURCE_LINE_PREFIX}warm` : `${REPO_SOURCE_LINE_PREFIX}clone ${reason ?? 'disabled'}`;
}

export function formatPhaseLine(phase: RunPhase, at: number): string {
  return `${PHASE_LINE_PREFIX}${phase} ${Math.floor(at)}`;
}

export function phaseLinesEnabled(env: Record<string, string | undefined>): boolean {
  return env.BUILDD_EXECUTOR === 'cloud';
}

export function emitPhase(
  phase: RunPhase,
  opts: { env?: Record<string, string | undefined>; now?: () => number; log?: (line: string) => void } = {},
): void {
  if (!phaseLinesEnabled(opts.env ?? process.env)) return;
  (opts.log ?? console.log)(formatPhaseLine(phase, (opts.now ?? Date.now)()));
}

type EmitOpts = Parameters<typeof emitPhase>[1];

export function emitMetric(name: RunMetric, value: number, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(formatMetricLine(name, value));
}

export function emitRepoSource(source: RepoSource, reason?: RepoFallbackReason, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(formatRepoSourceLine(source, reason));
}

/** Run `fn` between `<step>_start` and `<step>_end`; the end is printed even if it throws. */
export function timedPhase<T>(step: 'clone' | 'install' | 'restore_warm' | 'fetch' | 'warm_upload', fn: () => T, opts?: EmitOpts): T {
  emitPhase(`${step}_start`, opts);
  try {
    return fn();
  } finally {
    emitPhase(`${step}_end`, opts);
  }
}
