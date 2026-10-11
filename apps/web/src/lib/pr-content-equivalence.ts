/**
 * Does a PR's new head carry the same change as the commit that was reviewed?
 *
 * A rebase or base merge moves the head SHA without changing what the PR
 * does. Comparing `base...sha` at both commits (GitHub's three-dot compare
 * diffs from the merge base) yields the PR's own diff at each point; if the
 * two carry the same added/removed lines, a verdict on the first still
 * describes the second. Per file, an identical blob SHA proves identical
 * content outright — the only check available for a file GitHub sends no
 * patch for (a large generated drizzle snapshot, a binary); otherwise the
 * PR's own added/removed lines must match exactly, in order. Context the
 * base changed around them is not the PR's change — CI on the new head is
 * what checks the combination. Anything unverifiable — a failed read, a
 * truncated file list, a patchless file whose blob changed — is reported as
 * NOT equivalent.
 */

import { githubApi } from '@/lib/github';

export interface CompareFile {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
  /** Blob SHA of the file at the compared head. */
  sha?: string;
}

type Api = (installationId: number, path: string) => Promise<unknown>;

/** GitHub's compare endpoint returns at most this many files. */
export const COMPARE_FILE_LIMIT = 300;

/**
 * A PR's own file list, bounded against `baseRef` rather than against
 * another commit on the same branch. `compare/baseRef...sha` is GitHub's
 * merge-base-aware diff of the PR's tree against the base branch — a file
 * the base branch changed independently never appears, because the PR's
 * tree already matches base for that file at the merge-base. That holds
 * regardless of how the PR branch got to `sha` (rebase, merge-in, whatever),
 * which is what makes it safe to call at two different points on the same
 * branch and read the difference as "what the PR itself changed between
 * them" — see `reviewer.ts`'s delta-bounding use of this.
 */
export async function compareAgainstBase(params: {
  installationId: number;
  repoFullName: string;
  baseRef: string;
  sha: string;
  api?: Api;
}): Promise<CompareFile[] | null> {
  const api = params.api ?? githubApi;
  const data = (await api(
    params.installationId,
    `/repos/${params.repoFullName}/compare/${encodeURIComponent(params.baseRef)}...${params.sha}`,
  )) as { files?: CompareFile[] } | null;
  return Array.isArray(data?.files) ? data.files : null;
}

/**
 * Reduce a patch to the PR's own changed lines, in order. Hunk headers (line
 * numbers, enclosing-function label) and context lines are dropped: a base
 * change above or beside a hunk moves or alters those without changing what
 * the PR itself adds or removes.
 */
export function normalizePatch(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .join('\n');
}

export async function isContentEquivalentHead(params: {
  installationId: number;
  repoFullName: string;
  baseRef: string;
  fromSha: string;
  toSha: string;
  api?: Api;
}): Promise<{ equivalent: boolean; reason: string }> {
  const api = params.api ?? githubApi;
  const read = (sha: string) =>
    compareAgainstBase({ installationId: params.installationId, repoFullName: params.repoFullName, baseRef: params.baseRef, sha, api });

  let from: CompareFile[] | null;
  let to: CompareFile[] | null;
  try {
    [from, to] = await Promise.all([read(params.fromSha), read(params.toSha)]);
  } catch (err) {
    return { equivalent: false, reason: `could not compare: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!from || !to) return { equivalent: false, reason: 'could not compare: malformed compare response' };
  if (from.length >= COMPARE_FILE_LIMIT || to.length >= COMPARE_FILE_LIMIT) {
    return { equivalent: false, reason: 'file list may be truncated' };
  }

  return sameFiles(from, to)
    ? { equivalent: true, reason: 'PR diff unchanged' }
    : { equivalent: false, reason: 'PR diff changed' };
}

function sameFiles(from: CompareFile[], to: CompareFile[]): boolean {
  if (from.length !== to.length) return false;
  const byName = new Map(to.map((f) => [f.filename, f]));
  for (const a of from) {
    const b = byName.get(a.filename);
    if (!b || a.status !== b.status || (a.previous_filename ?? '') !== (b.previous_filename ?? '')) return false;
    if (a.sha && a.sha === b.sha) continue;
    if (typeof a.patch !== 'string' || typeof b.patch !== 'string') return false;
    if (normalizePatch(a.patch) !== normalizePatch(b.patch)) return false;
  }
  return true;
}

/**
 * A retarget's evidence (24e1cfad): does `sha` bring the same change into
 * `toBase` as into `fromBase`? For each base, the PR's diff (`base...sha`) less
 * the files whose content at `sha` that base's tip already holds (a squash- or
 * merge-landed parent PR, for a stacked PR retargeted onto trunk). The two sets
 * must match file for file, patch for patch. The head is one commit, so blob
 * SHAs at the head cannot tell the two diffs apart; patches can. Fails closed:
 * an unreadable or truncated compare (a deleted old base) is "not equivalent".
 */
export async function isBaseDiffEquivalent(params: {
  installationId: number;
  repoFullName: string;
  fromBase: string;
  toBase: string;
  sha: string;
  api?: Api;
}): Promise<{ equivalent: boolean; reason: string }> {
  const api = params.api ?? githubApi;
  const compare = async (base: string, head: string): Promise<CompareFile[] | null> => {
    const data = (await api(
      params.installationId,
      `/repos/${params.repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    )) as { files?: CompareFile[] } | null;
    return Array.isArray(data?.files) ? data.files : null;
  };
  /** The PR's change into `base` that the base does not already carry. */
  const novel = async (base: string): Promise<CompareFile[] | null> => {
    const [pr, onBase] = await Promise.all([compare(base, params.sha), compare(params.sha, base)]);
    if (!pr || !onBase || pr.length >= COMPARE_FILE_LIMIT || onBase.length >= COMPARE_FILE_LIMIT) return null;
    const baseHas = new Map(onBase.filter((f) => f.status !== 'removed' && f.sha).map((f) => [f.filename, f.sha]));
    return pr.filter((f) => !(f.status !== 'removed' && f.sha && baseHas.get(f.filename) === f.sha));
  };
  let from: CompareFile[] | null;
  let to: CompareFile[] | null;
  try {
    [from, to] = await Promise.all([novel(params.fromBase), novel(params.toBase)]);
  } catch (err) {
    return { equivalent: false, reason: `could not compare: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!from || !to) return { equivalent: false, reason: 'could not compare (unreadable, malformed or truncated)' };
  if (from.length !== to.length) return { equivalent: false, reason: 'PR diff changed' };
  const byName = new Map(to.map((f) => [f.filename, f]));
  for (const a of from) {
    const b = byName.get(a.filename);
    if (!b || a.status !== b.status || (a.previous_filename ?? '') !== (b.previous_filename ?? '')) return { equivalent: false, reason: 'PR diff changed' };
    if (typeof a.patch !== 'string' || typeof b.patch !== 'string') return { equivalent: false, reason: 'patch unavailable' };
    if (normalizePatch(a.patch) !== normalizePatch(b.patch)) return { equivalent: false, reason: 'PR diff changed' };
  }
  return { equivalent: true, reason: 'PR diff unchanged' };
}
