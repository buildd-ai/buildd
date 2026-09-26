/**
 * Display form of a git branch name. Generated branch names are capped
 * mid-slug (`packages/core/branch-names.ts`), so a stored name can end on a
 * separator ("…-render-invoices-"), which reads as a rendering bug. This trims
 * to a token boundary (`/`, `-`, `_`) and marks the cut with an ellipsis.
 * Callers keep the full name in a `title`.
 */
const SEP = /[-/_.]/;
const TRAILING_SEP = /[-/_.]+$/;

function lastSeparator(s: string): number {
  return Math.max(s.lastIndexOf('/'), s.lastIndexOf('-'), s.lastIndexOf('_'));
}

export function displayBranchName(branch: string | null | undefined, max = 48): string {
  if (!branch) return '';
  if (branch.length <= max && !TRAILING_SEP.test(branch)) return branch;
  let name = branch;
  if (name.length > max) {
    // Room for the ellipsis: at most max - 1 characters, backed off to the
    // last separator so no token is cut in half (hard cut if there is none).
    const head = name.slice(0, max - 1);
    const at = SEP.test(name.charAt(max - 1)) ? head.length : lastSeparator(head);
    name = at > 0 ? head.slice(0, at) : head;
  }
  return `${name.replace(TRAILING_SEP, '') || name}…`;
}
