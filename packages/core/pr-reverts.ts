/**
 * "This reverts that", read from GitHub text: a merged PR's title and body,
 * and commit messages on a workspace's branch. Each reference becomes one
 * `pr_reverts` row, and a candidate memory whose source PR has one is never
 * promoted (see promotionCandidatesQuery in ./memory-lifecycle).
 *
 * Two shapes, both conservative (a false revert only holds a candidate back):
 *
 * - **A PR reference on a line with revert language**: GitHub's revert button
 *   writes `Reverts owner/repo#N`; a squash title keeps the original's
 *   `(#N)`. A `#N` on a line with no "revert" is a mention, not a revert.
 * - **`This reverts commit <sha>`**, which `git revert` writes. Matched later
 *   against the source PR's merge sha by prefix, so an abbreviated sha works.
 *
 * Pure: no DB import. The web app writes the rows (apps/web/src/lib/pr-reverts.ts).
 */

export interface RevertReferences {
  prNumbers: number[];
  shas: string[];
}

const REVERT_WORD = /\brevert/i;
const COMMIT_REVERT = /this reverts commit ([0-9a-f]{7,40})\b/gi;
const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const PR_REF = /(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

export function parseRevertReferences(text: string | null | undefined, repoFullName: string): RevertReferences {
  const prNumbers = new Set<number>();
  const shas = new Set<string>();
  if (!text) return { prNumbers: [], shas: [] };
  const repo = repoFullName.toLowerCase();
  const sameRepo = (r: string | undefined) => !r || r.toLowerCase() === repo;

  for (const m of text.matchAll(COMMIT_REVERT)) shas.add(m[1].toLowerCase());

  for (const line of text.split('\n')) {
    if (!REVERT_WORD.test(line)) continue;
    // URLs first, then blank them so their digits are not read as a #ref.
    let rest = line;
    for (const m of line.matchAll(PR_URL)) {
      if (sameRepo(m[1])) prNumbers.add(Number(m[2]));
      rest = rest.replace(m[0], ' ');
    }
    for (const m of rest.matchAll(PR_REF)) {
      if (sameRepo(m[1])) prNumbers.add(Number(m[2]));
    }
  }
  return { prNumbers: [...prNumbers].filter(n => Number.isSafeInteger(n) && n > 0), shas: [...shas] };
}

export interface PrRevertRow {
  workspaceId: string;
  repo: string;
  /** `pr#N` for a merged PR, the commit sha for a commit. */
  revertedBy: string;
  revertedPrNumber: number | null;
  revertedSha: string | null;
  /** Unique per workspace: a webhook redelivery inserts nothing new. */
  dedupeKey: string;
}

/** The rows one merged PR or one commit records for one workspace. */
export function prRevertRows(args: {
  workspaceId: string;
  repo: string;
  revertedBy: string;
  text: string | null | undefined;
  /** The reverting PR's own number, never recorded as reverted by itself. */
  revertingPrNumber?: number;
}): PrRevertRow[] {
  const refs = parseRevertReferences(args.text, args.repo);
  const self = args.revertedBy.toLowerCase();
  const base = { workspaceId: args.workspaceId, repo: args.repo, revertedBy: args.revertedBy };
  return [
    ...refs.prNumbers
      .filter(n => n !== args.revertingPrNumber)
      .map(n => ({ ...base, revertedPrNumber: n, revertedSha: null, dedupeKey: `${args.revertedBy}>pr#${n}` })),
    ...refs.shas
      .filter(sha => !self.startsWith(sha))
      .map(sha => ({ ...base, revertedPrNumber: null, revertedSha: sha, dedupeKey: `${args.revertedBy}>${sha}` })),
  ];
}
