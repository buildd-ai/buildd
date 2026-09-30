/**
 * Machine-readable phase markers for a supervisor that only sees stdout.
 *
 * In a cloud container (BUILDD_EXECUTOR=cloud) the runner prints, on its own
 * line, `BUILDD_PHASE=<phase> <epoch ms>` at the start and end of the clone
 * and of the runner's own dependency install. apps/cloud-runner reads them
 * into its per-run report (src/run-report.ts parses the same format; a test
 * there keeps the two in step). Nothing else is printed: no paths, no URLs.
 *
 * Off everywhere else, so a long-lived runner's log is unchanged.
 */

export const PHASE_LINE_PREFIX = 'BUILDD_PHASE=';

export const RUN_PHASES = ['clone_start', 'clone_end', 'install_start', 'install_end'] as const;
export type RunPhase = typeof RUN_PHASES[number];

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

/** Run `fn` between `<step>_start` and `<step>_end`; the end is printed even if it throws. */
export function timedPhase<T>(step: 'clone' | 'install', fn: () => T, opts?: EmitOpts): T {
  emitPhase(`${step}_start`, opts);
  try {
    return fn();
  } finally {
    emitPhase(`${step}_end`, opts);
  }
}
