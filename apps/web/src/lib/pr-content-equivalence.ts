/**
 * Does a PR's new head carry the same change as the commit that was reviewed?
 *
 * A rebase or base merge moves the head SHA without changing what the PR
 * does. Comparing `base...sha` at both commits (GitHub's three-dot compare
 * diffs from the merge base) yields the PR's own diff at each point; if the
 * two are identical up to hunk positions, a verdict on the first still
 * describes the second. Anything unverifiable — a failed read, a truncated
 * file list, a file without a text patch — is reported as NOT equivalent.
 */

import { githubApi } from '@/lib/github';

export interface CompareFile {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
}

type Api = (installationId: number, path: string) => Promise<unknown>;

/** GitHub's compare endpoint returns at most this many files. */
const COMPARE_FILE_LIMIT = 300;

/** Strip hunk line numbers: a base change above a hunk shifts them, nothing else. */
export function normalizePatch(patch: string): string {
  return patch.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, '@@');
}

/** Order-independent signature of a PR diff, or null if any file can't be verified. */
export function contentDiffSignature(files: CompareFile[]): string | null {
  const parts: string[] = [];
  for (const f of files) {
    if (typeof f.patch !== 'string') return null;
    parts.push([f.status, f.previous_filename ?? '', f.filename, normalizePatch(f.patch)].join('\0'));
  }
  return parts.sort().join('\0\0');
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
  const read = async (sha: string): Promise<CompareFile[] | null> => {
    const data = (await api(
      params.installationId,
      `/repos/${params.repoFullName}/compare/${encodeURIComponent(params.baseRef)}...${sha}`,
    )) as { files?: CompareFile[] } | null;
    return Array.isArray(data?.files) ? data.files : null;
  };

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

  const a = contentDiffSignature(from);
  const b = contentDiffSignature(to);
  if (a === null || b === null) return { equivalent: false, reason: 'a changed file has no text patch to compare' };
  return a === b
    ? { equivalent: true, reason: 'PR diff unchanged' }
    : { equivalent: false, reason: 'PR diff changed' };
}
