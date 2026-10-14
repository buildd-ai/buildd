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
 * Invisible characters a name could hide behind: zero-width spaces and joiners,
 * the byte-order mark, the soft hyphen, and the bidi controls (embeddings,
 * overrides, isolates and marks) that can make a name render reversed.
 */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** At least one letter or digit, in any script. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The name as stored and shown: invisible characters removed, control
 * characters turned to spaces, trimmed, inner whitespace collapsed, cut to
 * RUNNER_NAME_MAX_LENGTH. Null when no letter or digit is left (or the value
 * is not a string). The runner (`buildd name`) and the server (heartbeat) both
 * go through here, so they accept and refuse the same names.
 */
export function normalizeRunnerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(INVISIBLE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!HAS_LETTER_OR_DIGIT.test(cleaned)) return null;
  const cut = [...cleaned].slice(0, RUNNER_NAME_MAX_LENGTH).join('').trim();
  return HAS_LETTER_OR_DIGIT.test(cut) ? cut : null;
}
