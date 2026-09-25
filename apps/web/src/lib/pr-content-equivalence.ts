/**
 * Does a PR's new head carry the same change as the commit that was reviewed?
 *
 * A rebase or base merge moves the head SHA without changing what the PR
 * does. Comparing `base...sha` at both commits (GitHub's three-dot compare
 * diffs from the merge base) yields the PR's own diff at each point; if the
 * two are identical up to hunk positions, a verdict on the first still
 * describes the second. Per file, an identical blob SHA proves identical
 * content outright — the only check available for a file GitHub sends no
 * patch for (a large generated drizzle snapshot, a binary); otherwise the
 * normalized patches must match. Anything unverifiable — a failed read, a
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
const COMPARE_FILE_LIMIT = 300;

/** Strip hunk line numbers: a base change above a hunk shifts them, nothing else. */
export function normalizePatch(patch: string): string {
  return patch.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, '@@');
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
