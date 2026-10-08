/**
 * Machine-readable phase markers for a supervisor that only sees stdout.
 *
 * In a cloud container (BUILDD_EXECUTOR=cloud) the runner prints, on its own
 * line, `BUILDD_PHASE=<phase> <epoch ms>` at the start and end of the clone
 * and of the runner's own dependency install, and of the warm-repo steps
 * (restore, the post-restore fetch, the snapshot upload; warm-repo.ts).
 * Alongside them: `BUILDD_METRIC=<name> <integer>` for byte counts and ages,
 * and `BUILDD_REPO_SOURCE=warm`, `BUILDD_REPO_SOURCE=reuse` or `BUILDD_REPO_SOURCE=clone <reason>` saying
 * how the repo got onto the disk, and `BUILDD_WARM_UPLOAD=skipped <reason>`
 * when a warm upload was skipped. apps/cloud-runner reads them all into its
 * per-run report (src/run-report.ts parses the same formats; a test there
 * keeps the two in step). Nothing else is printed: no paths, no URLs.
 *
 * Off everywhere else, so a long-lived runner's log is unchanged.
 */

export const WORKTREE_MODE_LINE_PREFIX = 'BUILDD_WORKTREE_MODE=';
export type WorktreeMode = 'clone' | 'worktree';

export const PHASE_LINE_PREFIX = 'BUILDD_PHASE=';

export const RUN_PHASES = [
  'clone_start', 'clone_end', 'install_start', 'install_end',
  'restore_warm_start', 'restore_warm_end', 'fetch_start', 'fetch_end',
  'warm_upload_start', 'warm_upload_end',
  'park_start', 'park_end', 'restore_park_start', 'restore_park_end',
  'restore_cache_start', 'restore_cache_end',
  // A reused container: the clone grown from the packs the reset kept (container-reset.ts).
  'restore_reuse_start', 'restore_reuse_end',
  'worktree_start', 'worktree_end',
  // Deps in the background (deps-gate.ts): when the agent session started, when
  // the deps work finished, when the agent first ran a command that needs it.
  'session_start', 'deps_ready', 'first_gated_tool',
] as const;
export type RunPhase = typeof RUN_PHASES[number];

export const METRIC_LINE_PREFIX = 'BUILDD_METRIC=';
export const RUN_METRICS = [
  'clone_bytes', 'restore_bytes', 'fetch_bytes', 'cache_bytes', 'snapshot_age_ms', 'warm_upload_bytes',
  'park_bytes', 'resume_layer', 'warm_repo_bytes', 'cache_raw_bytes',
  // resource-sampler.ts: working-set peak, the memory it is measured against,
  // lowest free disk and the disk's size. Re-printed as they move; last wins.
  'mem_peak_bytes', 'mem_limit_bytes', 'disk_free_min_bytes', 'disk_total_bytes',
  // deps-gate.ts: total time deps-needing commands were held, and how many were. Last wins.
  'gate_wait_ms', 'gate_holds',
] as const;
export type RunMetric = typeof RUN_METRICS[number];

/**
 * `BUILDD_WARM_UPLOAD=skipped <reason>`: the run ended without uploading a
 * warm snapshot it would otherwise have uploaded. `too_large`: the repo (or
 * the bundle, as it streamed) was over the cap (warm-repo.ts).
 */
export const WARM_UPLOAD_LINE_PREFIX = 'BUILDD_WARM_UPLOAD=';
export const WARM_UPLOAD_SKIP_REASONS = ['too_large'] as const;
export type WarmUploadSkipReason = typeof WARM_UPLOAD_SKIP_REASONS[number];

/**
 * `BUILDD_WARM_REFRESH=<reason>`: why a warm snapshot was refreshed (uploaded).
 * `age`: older than WARM_MAX_AGE_MS. `fetch`: post-restore fetch was large.
 * `cache_growth`: cache grew materially during the run.
 */
export const WARM_REFRESH_LINE_PREFIX = 'BUILDD_WARM_REFRESH=';
export const WARM_REFRESH_REASONS = ['age', 'fetch', 'cache_growth'] as const;
export type WarmRefreshReason = typeof WARM_REFRESH_REASONS[number];

export function formatWarmUploadSkippedLine(reason: WarmUploadSkipReason): string {
  return `${WARM_UPLOAD_LINE_PREFIX}skipped ${reason}`;
}

/**
 * `BUILDD_CACHE_SKIPPED=<part> <bytes> <cap>`: part of the dependency cache
 * was left out of the warm upload for size. `pnpm-store`: the pnpm store
 * alone (the rest of the cache still uploads); `cache`: the whole cache
 * tarball. `bytes` is the part's size on disk, `cap` the warm cap.
 */
export const CACHE_SKIPPED_LINE_PREFIX = 'BUILDD_CACHE_SKIPPED=';
export const CACHE_SKIP_PARTS = ['pnpm-store', 'cache'] as const;
export type CacheSkipPart = typeof CACHE_SKIP_PARTS[number];

export function formatCacheSkippedLine(part: CacheSkipPart, bytes: number, cap: number): string {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return `${CACHE_SKIPPED_LINE_PREFIX}${part} ${n(bytes)} ${n(cap)}`;
}

export const REPO_SOURCE_LINE_PREFIX = 'BUILDD_REPO_SOURCE=';
/** Why the repo was cloned rather than restored from a warm snapshot. */
export const REPO_FALLBACK_REASONS = ['disabled', 'no_snapshot', 'unavailable', 'disk', 'restore_failed'] as const;
export type RepoFallbackReason = typeof REPO_FALLBACK_REASONS[number];
/** `reuse`: grown from the packs a container reset kept (container-reset.ts). */
export type RepoSource = 'warm' | 'clone' | 'reuse';

export function formatMetricLine(name: RunMetric, value: number): string {
  const v = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${METRIC_LINE_PREFIX}${name} ${v}`;
}

export function formatRepoSourceLine(source: RepoSource, reason?: RepoFallbackReason): string {
  return source === 'clone' ? `${REPO_SOURCE_LINE_PREFIX}clone ${reason ?? 'disabled'}` : `${REPO_SOURCE_LINE_PREFIX}${source}`;
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

export function emitWarmUploadSkipped(reason: WarmUploadSkipReason, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(formatWarmUploadSkippedLine(reason));
}

export function emitCacheSkipped(part: CacheSkipPart, bytes: number, cap: number, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(formatCacheSkippedLine(part, bytes, cap));
}

export function emitWarmRefresh(reason: WarmRefreshReason, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(`${WARM_REFRESH_LINE_PREFIX}${reason}`);
}

/** Run `fn` between `<step>_start` and `<step>_end`; the end is printed even if it throws. */
export function timedPhase<T>(step: 'worktree' | 'clone' | 'install' | 'restore_warm' | 'fetch' | 'warm_upload' | 'park' | 'restore_park' | 'restore_cache', fn: () => T, opts?: EmitOpts): T {
  emitPhase(`${step}_start`, opts);
  try {
    return fn();
  } finally {
    emitPhase(`${step}_end`, opts);
  }
}

export function formatWorktreeModeLine(mode: WorktreeMode): string {
  return `${WORKTREE_MODE_LINE_PREFIX}${mode}`;
}

export function emitWorktreeMode(mode: WorktreeMode, opts: EmitOpts = {}): void {
  if (!phaseLinesEnabled(opts?.env ?? process.env)) return;
  (opts?.log ?? console.log)(formatWorktreeModeLine(mode));
}
