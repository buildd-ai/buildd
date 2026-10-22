/**
 * Named replacements: a closed-unmerged PR whose successor someone NAMED.
 *
 * Three ways a name arrives: a close comment `Replaced by #N` (or `superseded
 * by #N`), a later PR's body `replaces #N` (or `supersedes #N`), or a person's
 * "Link replacement" on the dashboard. None of them is verified: the named PR
 * may not exist or may never merge. So the claim is display only
 * (`workers.namedReplacementPrNumber`), and never read by a completion or merge
 * gate. The formal supersession (`workers.supersededByPrNumber`) is still
 * recorded, verified, once the replacement merges.
 *
 * Pure parsing lives here; the write is `recordNamedReplacement` in
 * `./pr-named-replacement-store`.
 */

/**
 * The canonical PR URL. Same shape as `prUrlFor` in `./repo-scope`, kept here
 * so this module imports nothing (tests stub repo-scope freely).
 */
export function prUrlFor(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

/** A positive integer PR number, or null. */
function prNumberOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Drops fenced code blocks (``` or ~~~), so a quoted example is not a claim. */
function withoutFencedCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

const CLOSE_RE = /\b(?:replaced|superseded)\s+by\s+#(\d+)\b/i;
const BODY_RE = /\b(?:replaces|supersedes)\s+#(\d+)\b/gi;

/** The replacement a close comment names (`Replaced by #N`, `superseded by #N`): the first one, or null. */
export function replacementNamedInClose(text: string | null | undefined): number | null {
  if (!text) return null;
  return prNumberOf(withoutFencedCode(text).match(CLOSE_RE)?.[1]);
}

/** The PRs a PR body says it replaces (`replaces #N`, `supersedes #N`), deduped, in order. */
export function replacedNamedInBody(text: string | null | undefined): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of withoutFencedCode(text).matchAll(BODY_RE)) {
    const n = prNumberOf(m[1]);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}
