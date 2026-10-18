/**
 * GitHub's 405 for a merge a required check has not passed yet ("Required
 * status check "X" is expected", "... is in progress", "2 of 3 required status
 * checks are expected"). It is a wait, never a refusal: nothing is wrong with
 * the PR, the check has not reported. Every merge door reads it here so a
 * required check holds the merge and retries (workflow-kernel-library.md §4,
 * merge holds) instead of parking the PR on a person or failing a release.
 *
 * A required check that is failing is not a hold: that answer stays a refusal.
 */

const WAITING = /\b(?:is|are|has not|have not)\s+(?:yet\s+)?(?:expected|pending|in progress|queued|waiting|reported|succeeded|passed)\b/i;

/** The hold GitHub's answer describes, with the first check it names (null when it gives only a count); null when it is not one. */
export function requiredCheckHold(message: string | null | undefined): { check: string | null } | null {
  if (!message) return null;
  // A thrown `GitHub API error: 405 {...}` carries the JSON body with its quotes escaped.
  const m = message.replace(/\\"/g, '"');
  const at = m.search(/required status checks?\b/i);
  if (at < 0) return null;
  const rest = m.slice(at);
  if (/\bfail(?:ing|ed)\b/i.test(rest.split(/\r?\n/)[0] ?? '')) return null;
  if (!WAITING.test(rest)) return null;
  const named = /required status checks?\s+"([^"]+)"/i.exec(rest);
  return { check: named?.[1] ?? null };
}
