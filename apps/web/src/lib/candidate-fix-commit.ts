/**
 * A red candidate's fix can reach its source branch without a PR: an `autofix:`
 * commit pushed straight to dev, or a PR another task opened and then closed
 * because the same change landed directly. The amend-on-merge path never sees
 * either, so the fix task names the commit instead (`complete_task
 * alreadyShippedIn: <sha>`) and the completion amends the candidate
 * (lib/release/candidate-amend.ts, `amendCandidateOnFixCompletion`).
 *
 * The claim is checked here before the pr_required gate accepts it: the
 * commit exists, is on the candidate's source branch, and is not already in
 * the candidate (a commit the red candidate already holds cannot be its fix).
 *
 * Only reads GitHub through the injected `api`, so the worker route can call it
 * without pulling in the release dispatch modules.
 */
/**
 * Context key on the fix task (the same string as RELEASE_CANDIDATE_FIX_KEY in
 * lib/release-candidate-ci.ts, which a test pins): declared here so core, which
 * the worker route is part of, imports no releases-module file.
 */
const RELEASE_CANDIDATE_FIX_KEY = 'releaseCandidateFix';

/** Task result key: the dev commit a candidate fix task named as carrying the fix. */
export const RELEASE_CANDIDATE_FIX_COMMIT_KEY = 'candidateFixLanded';

export interface ReleaseCandidateFixContext {
  prNumber: number;
  headSha: string;
  version: string;
  branch: string;
  sourceBranch: string;
}

/** What the completion records on the task result when the commit checks out. */
export interface CandidateFixLanded {
  commitSha: string;
  sourceBranch: string;
  candidatePr: number;
}

/** A hex object name, but not a bare number: `5647` names a PR, never a commit. */
export function commitShaOf(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^[0-9a-f]{7,40}$/i.test(s) || /^\d+$/.test(s)) return null;
  return s.toLowerCase();
}

export function releaseCandidateFixOf(context: unknown): ReleaseCandidateFixContext | null {
  const fix = (context as Record<string, unknown> | null | undefined)?.[RELEASE_CANDIDATE_FIX_KEY] as
    | Partial<ReleaseCandidateFixContext>
    | undefined;
  if (!fix || typeof fix.version !== 'string' || typeof fix.sourceBranch !== 'string' || typeof fix.headSha !== 'string' || typeof fix.prNumber !== 'number') {
    return null;
  }
  return fix as ReleaseCandidateFixContext;
}

type Api = (installationId: number, path: string, opts?: any) => Promise<any>;

const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** `ancestor` is reachable from `head`. Null when GitHub cannot say. */
async function contains(api: Api, installationId: number, repo: string, ancestor: string, head: string): Promise<boolean | null> {
  try {
    const data = await api(installationId, `/repos/${repo}/compare/${ancestor}...${head}`);
    if (typeof data?.status !== 'string') return null;
    return data.status === 'ahead' || data.status === 'identical';
  } catch {
    return null;
  }
}

export type CandidateFixCommitCheck =
  | { ok: true; landed: CandidateFixLanded }
  | { ok: false; refusal: string };

export async function verifyCandidateFixCommit(p: {
  api: Api;
  installationId: number;
  repoFullName: string;
  sha: string;
  fix: ReleaseCandidateFixContext;
}): Promise<CandidateFixCommitCheck> {
  const short = p.sha.slice(0, 12);
  let full: string | null = null;
  try {
    const commit = await p.api(p.installationId, `/repos/${p.repoFullName}/commits/${p.sha}`);
    full = typeof commit?.sha === 'string' ? commit.sha : null;
  } catch { /* refused below */ }
  if (!full) return { ok: false, refusal: `commit ${short} could not be read from ${p.repoFullName}.` };

  const onSource = await contains(p.api, p.installationId, p.repoFullName, full, encodeRef(p.fix.sourceBranch));
  if (onSource === null) return { ok: false, refusal: `could not check whether commit ${short} is on \`${p.fix.sourceBranch}\`.` };
  if (!onSource) {
    return { ok: false, refusal: `commit ${short} is not on \`${p.fix.sourceBranch}\`, so it does not show the fix landed where release candidate v${p.fix.version} is cut from.` };
  }
  const inCandidate = await contains(p.api, p.installationId, p.repoFullName, full, p.fix.headSha);
  if (inCandidate === null) return { ok: false, refusal: `could not check whether commit ${short} is already in release candidate v${p.fix.version}.` };
  if (inCandidate) {
    return { ok: false, refusal: `commit ${short} is already in release candidate v${p.fix.version} (PR #${p.fix.prNumber}), which is red with it, so it is not the fix.` };
  }
  return { ok: true, landed: { commitSha: full, sourceBranch: p.fix.sourceBranch, candidatePr: p.fix.prNumber } };
}
