/**
 * What review a frozen release candidate is owed (docs/specs/release-flow.md
 * AC-14, AC-25 to AC-27).
 *
 * A candidate has no kernel delivery (release-flow.md, "no kernel delivery, by
 * design"), so the kernel's `dispatch_review` effect, where composition is
 * otherwise attested, never runs for it. This is the same attestation, asked by
 * the landing gate at the candidate's exact head: every commit that is an
 * approved PR on the source branch (squashed, or merged with a merge commit),
 * the release-only commit and the prod branch merged back after the last
 * release are covered; what is left (a direct commit to the source branch, an
 * unapproved PR, a landed patch that differs from its approved head) is the
 * delta, and only the delta is reviewed. Nothing covered is judged again: not
 * the size cap, not the workspace's path classes.
 *
 * Read-only on the kernel tables (the constituents' rounds). It writes nothing
 * but the PR description's composition block, a report of the answer, never an
 * input to it. Anything the check cannot see is `unverifiable`, which keeps
 * the full review.
 */
import { db } from '@buildd/core/db';
import { classifyReleasePr, releaseConstituentBase } from '@buildd/core/release-candidate';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import type { Exec } from './kernel';
import { collectComposition, type CompositionResult, type FileDiff, type GithubApi } from './review-composition';
import { compositionBlock, withCompositionBlock } from './composition-description';

export type CandidateReviewScope =
  /** Not a trusted candidate at this head (or the PR is unreadable): the PR's ordinary review applies. */
  | { kind: 'not_candidate' }
  /** Every change was reviewed on its own PR: no reviewer at all; the attestation is the review. */
  | { kind: 'composed'; headSha: string; constituents: number }
  /** Commits no review covers: one reviewer, over exactly these. */
  | { kind: 'delta'; headSha: string; commits: Array<{ sha: string; reason: string; paths: string[] }>; paths: string[]; files: DeltaFile[] }
  /** The proof could not be read: the full review stays. */
  | { kind: 'unverifiable'; headSha: string; reason: string };

/** A delta file in the shape the reviewer prompt lists (GitHub's PR `files[]`). */
export interface DeltaFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CandidateReviewInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  releaseConfig: WorkspaceReleaseConfig | null;
}

export interface CandidateReviewDeps {
  api?: GithubApi;
  exec?: Exec;
  collect?: typeof collectComposition;
  now?: () => number;
}

interface GhPull {
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
  user?: { login?: string } | null;
  body?: string | null;
}

/** One answer per candidate head for a while: the read is a few hundred GitHub calls, and a head never changes. */
const MEMO_TTL_MS = 10 * 60_000;
const memo = new Map<string, { at: number; scope: CandidateReviewScope }>();

export function clearCandidateReviewMemo(): void {
  memo.clear();
}

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** The delta's files, merged across its commits (the reviewer reads each commit with `git show`). */
export function deltaFiles(result: CompositionResult, paths: string[]): DeltaFile[] {
  const byPath = new Map<string, DeltaFile>();
  const wanted = new Set(paths);
  for (const n of result.novelCommits) {
    for (const f of (result.novelDiffs?.[n.sha] ?? []) as FileDiff[]) {
      if (!wanted.has(f.filename)) continue;
      const lines = (f.patch ?? '').split('\n');
      const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      const prior = byPath.get(f.filename);
      byPath.set(f.filename, {
        filename: f.filename,
        status: prior ? 'modified' : (f.status ?? 'modified'),
        additions: (prior?.additions ?? 0) + additions,
        deletions: (prior?.deletions ?? 0) + deletions,
        // A path two commits changed has no one patch; the reviewer reads each commit.
        ...(prior ? {} : f.patch ? { patch: f.patch } : {}),
      });
    }
  }
  for (const p of paths) if (!byPath.has(p)) byPath.set(p, { filename: p, status: 'modified', additions: 0, deletions: 0 });
  return [...byPath.values()].sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function candidateReviewScope(input: CandidateReviewInput, deps: CandidateReviewDeps = {}): Promise<CandidateReviewScope> {
  const api = deps.api ?? (githubApi as GithubApi);
  const now = deps.now ?? Date.now;
  const { repoFullName: repo, prNumber, installationId } = input;
  if (!input.releaseConfig?.candidate) return { kind: 'not_candidate' };

  let pull: GhPull | null;
  try {
    pull = (await api(installationId, `/repos/${repo}/pulls/${prNumber}`)) as GhPull | null;
  } catch {
    return { kind: 'not_candidate' };
  }
  const headSha = pull?.head?.sha ?? null;
  const headRef = pull?.head?.ref ?? null;
  const baseRef = pull?.base?.ref ?? null;
  if (!headSha || !headRef || !baseRef) return { kind: 'not_candidate' };
  // Provenance at this exact head: the author, the workflow's metadata naming this SHA. After an
  // amendment the metadata names the new head, so the new head is classified (and composed) afresh.
  const cls = classifyReleasePr(input.releaseConfig, {
    headRef, baseRef, headSha,
    author: pull?.user?.login ?? null,
    headRepoFullName: pull?.head?.repo?.full_name ?? null,
    baseRepoFullName: pull?.base?.repo?.full_name ?? null,
    body: pull?.body ?? null,
  });
  if (cls.kind !== 'candidate') return { kind: 'not_candidate' };
  const constituentBase = releaseConstituentBase(cls);
  if (!constituentBase) return { kind: 'not_candidate' };

  const key = `${repo}#${prNumber}@${headSha}`;
  const hit = memo.get(key);
  if (hit && now() - hit.at < MEMO_TTL_MS) return hit.scope;

  let built: CompositionResult;
  try {
    built = await (deps.collect ?? collectComposition)({
      api, exec: deps.exec ?? dbExec, installationId, workspaceId: input.workspaceId, repoFullName: repo, prNumber,
      baseRef, headRef, aggregateHeadSha: headSha, constituentBase, aggregateFromCommits: true,
    });
  } catch (err) {
    const reason = `composition_read_failed: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[candidate-review] ${repo}#${prNumber} at ${headSha.slice(0, 12)}: ${reason}; full review`);
    return { kind: 'unverifiable', headSha, reason };
  }

  const delta = built.attestation.novelDelta;
  let scope: CandidateReviewScope;
  if (delta.result === 'unverifiable') scope = { kind: 'unverifiable', headSha, reason: delta.reason };
  else if (delta.result === 'none') scope = { kind: 'composed', headSha, constituents: built.attestation.constituents.length };
  else {
    const commits = built.novelCommits
      .map((n) => ({ ...n, paths: n.paths.filter((p) => delta.paths.includes(p)) }))
      .filter((n) => n.paths.length > 0);
    scope = { kind: 'delta', headSha, commits, paths: delta.paths, files: deltaFiles(built, delta.paths) };
  }
  memo.set(key, { at: now(), scope });
  console.log(`[candidate-review] ${repo}#${prNumber} at ${headSha.slice(0, 12)}: ${scope.kind}${scope.kind === 'delta' ? ` (${scope.commits.length} commits, ${scope.paths.length} paths)` : scope.kind === 'unverifiable' ? ` (${scope.reason})` : ''}`);

  // The description says which part is reviewed constituent work and which is the delta. Best effort.
  try {
    const block = compositionBlock({
      attestation: built.attestation, novelCommits: built.novelCommits,
      deltaReview: delta.result === 'none' ? 'not_owed' : 'pending',
      gate: { state: scope.kind === 'composed' ? 'COMPOSED' : scope.kind === 'delta' ? 'AWAITING_DELTA_REVIEW' : 'AWAITING_REVIEW', openFindings: 0 },
    });
    const next = withCompositionBlock(pull?.body, block);
    if (next !== (pull?.body ?? '')) await api(installationId, `/repos/${repo}/pulls/${prNumber}`, { method: 'PATCH', body: JSON.stringify({ body: next }) });
  } catch (err) {
    console.warn(`[candidate-review] composition block for ${repo}#${prNumber} not written:`, err instanceof Error ? err.message : err);
  }
  return scope;
}
