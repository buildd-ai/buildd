/**
 * The path manifest a repair attempt (a builder filed after review, CI or a
 * conflict) is created with.
 *
 * A repair used to copy its owner's manifest verbatim. When the owner declared
 * no scope (`['**']`, or nothing), the repair was scope-undeclared too. A repair
 * edits the PR's files, so it can say so: the overlap policy then sees real
 * paths (an unmergeable one still holds). Scope is precision, never a
 * precondition to start: an undeclared repair starts as well.
 *
 * Result: the owner's concrete entries, unioned with the PR's changed files when
 * they are known. With neither, today's behaviour (the owner's manifest as it
 * is, including a sentinel or null) is kept. Later PR-scope reconciliation only
 * narrows, so a concrete manifest stays concrete.
 */
import { REPO_WIDE_SENTINEL, stripTrailingSep } from '@buildd/core/path-overlap';
import { readPinnedPrScope, type GithubGet } from '@buildd/core/pr-scope-read';

/** More changed files than this is not a cheap, useful scope: leave the owner's manifest alone. */
export const REPAIR_MANIFEST_MAX_FILES = 200;

export function repairPathManifest(
  ownerManifest: string[] | null | undefined,
  prFiles: string[] | null | undefined,
): string[] | null {
  const concrete = (ownerManifest ?? [])
    .filter(p => typeof p === 'string' && p.trim() && p.trim() !== REPO_WIDE_SENTINEL)
    .map(p => stripTrailingSep(p.trim()));
  const files = prFiles && prFiles.length <= REPAIR_MANIFEST_MAX_FILES ? prFiles : [];
  const union = [...new Set([...concrete, ...files])];
  if (union.length > 0) return union;
  return ownerManifest ?? null;
}

/** The PR's changed files at `headSha`, or null when they cannot be read completely and cheaply. */
export async function readRepairPrFiles(
  get: GithubGet,
  input: { repoFullName: string; prNumber: number; headSha?: string | null },
): Promise<string[] | null> {
  try {
    const read = await readPinnedPrScope(get, { ...input, expectedHeadSha: input.headSha ?? null });
    return read.status === 'complete' ? read.files : null;
  } catch {
    return null;
  }
}
