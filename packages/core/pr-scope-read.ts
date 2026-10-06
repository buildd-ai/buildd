/** Shared revision-pinned, paginated PR file reader for claims and outcome labels. */
import { stripTrailingSep } from './path-overlap';

/** GitHub's page size ceiling for GET /pulls/{n}/files. */
export const PR_FILES_PAGE_SIZE = 100;
/** GitHub lists at most this many files for a PR; anything beyond is invisible. */
export const PR_FILES_LIST_CAP = 3000;

export type PrScopeIncompleteReason =
  | 'read_failed'
  | 'malformed'
  | 'truncated'
  | 'head_moved'
  | 'base_moved';

export type PrScopeRead =
  | {
      status: 'complete'; files: string[]; headSha: string; baseSha: string;
      /** The base branch name (GitHub `base.ref`), when GitHub returned one. */
      baseRef?: string;
    }
  | { status: 'incomplete'; reason: PrScopeIncompleteReason; detail: string; headSha: string | null; baseSha: string | null }
  | { status: 'closed'; merged: boolean; headSha: string | null; baseSha: string | null };

export type GithubGet = (path: string) => Promise<unknown>;

interface PrHead { state: string; merged: boolean; headSha: string; baseSha: string; baseRef: string | null; changedFiles: number | null }

function parsePr(raw: unknown): PrHead | null {
  const pr = raw as Record<string, any> | null;
  const headSha = pr?.head?.sha;
  const baseSha = pr?.base?.sha;
  if (typeof headSha !== 'string' || !headSha || typeof baseSha !== 'string' || !baseSha) return null;
  return {
    state: typeof pr?.state === 'string' ? pr.state : 'open',
    merged: pr?.merged === true || typeof pr?.merged_at === 'string',
    headSha,
    baseSha,
    baseRef: typeof pr?.base?.ref === 'string' && pr.base.ref ? pr.base.ref : null,
    changedFiles: typeof pr?.changed_files === 'number' ? pr.changed_files : null,
  };
}

/**
 * Read a PR's complete file list, pinned to one head and one base.
 *
 * Every path in the result is a path the PR changes, including both sides of a
 * rename (the source is deleted by the PR as surely as the destination is
 * written). Anything short of a whole, unmoved list is `incomplete`.
 */
export async function readPinnedPrScope(
  get: GithubGet,
  input: { repoFullName: string; prNumber: number; expectedHeadSha?: string | null; allowClosed?: boolean },
): Promise<PrScopeRead> {
  const prPath = `/repos/${input.repoFullName}/pulls/${input.prNumber}`;
  const incomplete = (reason: PrScopeIncompleteReason, detail: string, at?: PrHead | null): PrScopeRead => ({
    status: 'incomplete', reason, detail, headSha: at?.headSha ?? null, baseSha: at?.baseSha ?? null,
  });

  let before: PrHead | null;
  try {
    before = parsePr(await get(prPath));
  } catch (err) {
    return incomplete('read_failed', `PR read failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  if (!before) return incomplete('malformed', 'PR response had no head/base sha');
  if (!input.allowClosed && (before.state === 'closed' || before.merged)) {
    return { status: 'closed', merged: before.merged, headSha: before.headSha, baseSha: before.baseSha };
  }
  if (input.allowClosed && (before.changedFiles === null || !Number.isInteger(before.changedFiles) || before.changedFiles < 0)) {
    return incomplete('malformed', 'PR response had no valid changed-file count', before);
  }
  if (input.expectedHeadSha && input.expectedHeadSha !== before.headSha) {
    return incomplete('head_moved', `expected head ${input.expectedHeadSha.slice(0, 7)}, PR is at ${before.headSha.slice(0, 7)}`, before);
  }

  const files = new Set<string>();
  let listed = 0;
  const maxPages = Math.ceil(PR_FILES_LIST_CAP / PR_FILES_PAGE_SIZE);
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      return incomplete('truncated', `file list reached GitHub's ${PR_FILES_LIST_CAP}-file cap`, before);
    }
    let batch: unknown;
    try {
      batch = await get(`${prPath}/files?per_page=${PR_FILES_PAGE_SIZE}&page=${page}`);
    } catch (err) {
      return incomplete('read_failed', `file page ${page} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, before);
    }
    if (!Array.isArray(batch)) return incomplete('malformed', `file page ${page} was not a list`, before);
    for (const f of batch as Array<Record<string, unknown>>) {
      if (typeof f?.filename !== 'string' || !f.filename) {
        return incomplete('malformed', `file page ${page} had an entry with no filename`, before);
      }
      listed++;
      files.add(stripTrailingSep(f.filename));
      if (typeof f.previous_filename === 'string' && f.previous_filename) {
        files.add(stripTrailingSep(f.previous_filename));
      }
    }
    if (batch.length < PR_FILES_PAGE_SIZE) break;
  }

  if (before.changedFiles !== null && listed < before.changedFiles) {
    return incomplete('truncated', `listed ${listed} of ${before.changedFiles} changed files`, before);
  }

  let after: PrHead | null;
  try {
    after = parsePr(await get(prPath));
  } catch (err) {
    return incomplete('read_failed', `PR re-read failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, before);
  }
  if (!after) return incomplete('malformed', 'PR re-read had no head/base sha', before);
  if (!input.allowClosed && (after.state === 'closed' || after.merged)) {
    return { status: 'closed', merged: after.merged, headSha: after.headSha, baseSha: after.baseSha };
  }
  if (after.headSha !== before.headSha) {
    return incomplete('head_moved', `head moved ${before.headSha.slice(0, 7)} -> ${after.headSha.slice(0, 7)} during the read`, after);
  }
  if (after.baseRef !== before.baseRef) {
    return incomplete('base_moved', `PR was retargeted ${before.baseRef ?? '?'} -> ${after.baseRef ?? '?'} during the read`, after);
  }
  if (after.baseSha !== before.baseSha) {
    return incomplete('base_moved', `base moved ${before.baseSha.slice(0, 7)} -> ${after.baseSha.slice(0, 7)} during the read`, after);
  }

  return {
    status: 'complete', files: [...files].sort(), headSha: before.headSha, baseSha: before.baseSha,
    ...(before.baseRef ? { baseRef: before.baseRef } : {}),
  };
}

