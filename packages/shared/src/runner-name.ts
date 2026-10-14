/**
 * A runner's display name (`buildd name <name>`, or `BUILDD_RUNNER_NAME`).
 *
 * The runner sends it as `environment.labels.name` on its heartbeat. It is a
 * label only: the runner's identity stays its `localUiUrl` (the heartbeat
 * row's key), so renaming never makes a second runner.
 */

/** Longest name kept; a runner column is narrow and a label is not a note. */
export const RUNNER_NAME_MAX_LENGTH = 48;

/**
 * The name as stored and shown: trimmed, inner whitespace collapsed, control
 * characters removed, cut to RUNNER_NAME_MAX_LENGTH. Null when nothing is left
 * (or the value is not a string).
 */
export function normalizeRunnerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, RUNNER_NAME_MAX_LENGTH).join('').trim();
}
