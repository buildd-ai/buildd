/**
 * Bot-generated title prefixes (reviewer dispatch, builder/reviewer retries,
 * apply-recommendation) and the predicate to strip them back to the human
 * title underneath.
 *
 * Lives in core, not `apps/web/src/lib/task-title.ts`, because
 * `isMissionPrTask` (mission-integration.ts) needs it too: a retry wraps a
 * task's title in `[builder · after review #N]` etc., and that wrap must not
 * make the mission-PR-owner task unrecognizable to its own exemption check.
 * One regex, read from both places, so they can't drift apart.
 */

// Leading, repeatable prefix fragments in any order:
//   New format: [builder · after review #N], [builder · after conflict #N], [builder · after CI #N], [reviewer #N]
//   Old format: [reviewer] PR #N:, [reviewer retry #N] PR #N:, [CI Retry #N], [Conflict Retry #N]
//   Other: [apply recommendation]
//
// Note: PR #N: is only stripped when part of a reviewer task prefix like [reviewer] PR #N:.
// Standalone PR #N: in adopted PR titles is NOT stripped.
const TITLE_PREFIX = /^\s*(?:\[reviewer\]\s+PR\s*#\d+:|\[reviewer\s+retry\s*#?\d*\]\s+PR\s*#\d+:|\[(?:builder\s+·\s+after\s+(?:review|conflict|CI)\s+#\d+|reviewer\s+#\d+|reviewer(?:\s+retry\s*#?\d*)?|CI\s+Retry\s*#?\d*|Conflict\s+Retry\s*#?\d*)\]|\[apply recommendation\])\s*/i;

/** Strip all bot-generated prefixes, returning the underlying human title. */
export function stripTaskTitlePrefixes(title: string | null | undefined): string {
  let t = title ?? '';
  let prev: string;
  do {
    prev = t;
    t = t.replace(TITLE_PREFIX, '');
  } while (t !== prev);
  return t.trim();
}
