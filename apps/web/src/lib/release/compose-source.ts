/**
 * The reads behind the owner's release flow (/app/releases/compose): what is
 * on dev since the last release, which mission PRs are ready, the open
 * candidate and its checks on its exact SHA, the merged candidate and what
 * production runs, and who pressed each button. The decisions are the pure
 * functions in packages/core/release-compose.ts; this file only gathers facts.
 *
 * GitHub is the truth for the candidate: its body metadata (written by
 * scripts/release-candidate.ts) pins the source and candidate SHAs and what
 * was left out. release_flow_steps adds who and when.
 */

import { db as defaultDb } from '@buildd/core/db';
import { missions, releaseFlowSteps, tasks, users, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import {
  candidateVerdict,
  defaultSelection,
  flowStep,
  groupComposition,
  productionState,
  releaseLede,
  REQUIRED_CANDIDATE_CHECKS,
  type CandidateCheck,
  type CandidateReview,
  type CandidateVerdict,
  type ComposeChecksSummary,
  type ComposeMission,
  type ComposePr,
  type Composition,
  type FlowStep,
  type ProductionState,
} from '@buildd/core/release-compose';
import { classifyReleasePr, releaseCandidatePolicy, type ReleaseCandidateMeta } from '@buildd/core/release-candidate';
import type { ReleaseTarget } from './target';

/** `githubApi` bound to one installation; throws on non-2xx like githubApi does. */
export type GithubGet = (path: string) => Promise<any>;

// ── Pure helpers (tested directly) ──────────────────────────────────────────

export interface CompareCommit {
  sha: string;
  commit: { message: string };
  parents: Array<{ sha: string }>;
}

/** PR numbers a commit subject credits: merge commits and `(#123)` suffixes. Same rule as the engine. */
export function prNumbersIn(subject: string): number[] {
  const out: number[] = [];
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  if (merge) out.push(Number(merge[1]));
  for (const m of subject.matchAll(/\(#(\d+)\)/g)) out.push(Number(m[1]));
  return out;
}

/**
 * The PRs that landed on the source branch in a compare range, newest first,
 * each with the commit that put it there. Only the first-parent chain from
 * `headSha` counts: a mission PR's merge commit stands for the whole mission,
 * and the task PRs merged into its integration branch (reachable through the
 * merge's second parent) are not separate changes on dev. Commits that credit
 * no PR (main merged back into dev, bump commits) are skipped.
 */
export function firstParentPrs(commits: CompareCommit[], headSha: string): Array<{ number: number; title: string; sha: string }> {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: Array<{ number: number; title: string; sha: string }> = [];
  const seen = new Set<number>();
  let cur = bySha.get(headSha);
  while (cur) {
    const [subject, ...rest] = cur.commit.message.split('\n');
    const nums = prNumbersIn(subject);
    if (nums.length > 0) {
      const number = nums[0];
      if (!seen.has(number)) {
        seen.add(number);
        // A merge commit's PR title is the first line of its body.
        const bodyTitle = rest.join('\n').trim().split('\n')[0]?.trim();
        const title = subject.startsWith('Merge pull request #') && bodyTitle ? bodyTitle : subject.replace(/\s*\(#\d+\)\s*$/, '');
        out.push({ number, title, sha: cur.sha });
      }
    }
    cur = cur.parents[0] ? bySha.get(cur.parents[0].sha) : undefined;
  }
  return out;
}

export interface CheckRunFact {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  completed_at?: string | null;
  started_at?: string | null;
}

/**
 * Check runs → per-check state on their own SHA, newest run per name. Only a
 * `success` passes. A skipped or neutral run is dropped unless the check is
 * required, where it counts as failing (a skipped required check verified
 * nothing).
 */
export function toCandidateChecks(runs: CheckRunFact[], required: readonly string[]): CandidateCheck[] {
  const newest = new Map<string, CheckRunFact>();
  for (const r of runs) {
    const prev = newest.get(r.name);
    const t = (x: CheckRunFact) => Date.parse(x.completed_at ?? x.started_at ?? '') || 0;
    if (!prev || t(r) >= t(prev)) newest.set(r.name, r);
  }
  const out: CandidateCheck[] = [];
  for (const r of newest.values()) {
    const soft = r.conclusion === 'skipped' || r.conclusion === 'neutral';
    if (soft && !required.includes(r.name)) continue;
    const state = r.status !== 'completed' ? 'pending' : r.conclusion === 'success' ? 'passing' : 'failing';
    out.push({ name: r.name, sha: r.head_sha, state, url: r.html_url ?? null });
  }
  return out;
}

export function summarizeRuns(runs: CheckRunFact[]): ComposeChecksSummary {
  const checks = toCandidateChecks(runs, []);
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failing')) return 'failing';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'passing';
}

/** Latest review per author; an approval counts on the SHA it was given on. */
export function latestReviews(raw: Array<{ user?: { login?: string } | null; state: string; commit_id?: string | null }>): CandidateReview[] {
  const byAuthor = new Map<string, CandidateReview>();
  for (const r of raw) {
    const author = r.user?.login ?? '';
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    byAuthor.set(author, { author, state: r.state as CandidateReview['state'], sha: r.commit_id ?? '' });
  }
  return [...byAuthor.values()];
}

const REFUSED_RE = /<!-- release-candidate:refused (\{[\s\S]*?\}) -->/;

export interface ExclusionRefusal {
  sha: string;
  files: string[];
  candidateSha: string;
  at: string;
}

/** The newest refused-exclusion comment the engine left on the candidate PR, if any. */
export function latestRefusal(comments: Array<{ body?: string | null }>): ExclusionRefusal | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = REFUSED_RE.exec(comments[i].body ?? '');
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (typeof j.sha === 'string' && Array.isArray(j.files)) return { sha: j.sha, files: j.files.map(String), candidateSha: String(j.candidateSha ?? ''), at: String(j.at ?? '') };
    } catch {
      /* not ours */
    }
  }
  return null;
}

// ── The view ────────────────────────────────────────────────────────────────

export interface FlowRecordEntry {
  id: string;
  step: string;
  outcome: string;
  actor: string;
  at: string;
  version: string | null;
  candidateSha: string | null;
  prNumber: number | null;
  detail: Record<string, unknown> | null;
}

export interface CandidateState {
  prNumber: number;
  url: string;
  version: string;
  candidateSha: string;
  sourceSha: string;
  amendment: number;
  previousCandidateSha: string | null;
  reverted: Array<{ sha: string; subject: string }>;
  verdict: CandidateVerdict;
  /** A refused exclusion against this candidate SHA (the revert did not apply cleanly). */
  refusal: ExclusionRefusal | null;
  /** previous candidate → this one, when amended: the delta to review. */
  deltaUrl: string | null;
}

export interface MergedCandidateState {
  prNumber: number;
  url: string;
  version: string;
  mergeSha: string;
  mergedAt: string;
  deployedSha: string | null;
  production: ProductionState;
  /** A person already confirmed production for this version. */
  confirmed: boolean;
}

export interface ReleaseFlowView {
  workspace: { id: string; name: string; repoFullName: string };
  sourceBranch: string;
  prodBranch: string;
  /** The source SHA the composition was read at (dev head, or the candidate's frozen source). */
  compositionSha: string | null;
  composition: Composition;
  defaultSelected: string[];
  /** Keys already left out of the open candidate. */
  leftOut: string[];
  candidate: CandidateState | null;
  merged: MergedCandidateState | null;
  step: FlowStep;
  lede: string;
  counts: { missions: number; other: number };
  record: FlowRecordEntry[];
  /** True when the compare range was truncated (GitHub returns at most 250 commits). */
  truncated: boolean;
}

export type LoadFlowResult = { ok: true; view: ReleaseFlowView } | { ok: false; status: number; error: string };

export interface LoadFlowDeps {
  db?: typeof defaultDb;
  github: GithubGet;
  /** The deployed SHA production reports, or null when it cannot be read. */
  deployedSha: (verificationUrl: string) => Promise<string | null>;
}

const CLOSED_MISSION_STATUSES = ['completed', 'archived'] as const;

async function checkRunsFor(github: GithubGet, repo: string, sha: string): Promise<CheckRunFact[]> {
  const res = await github(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  return (res?.check_runs ?? []) as CheckRunFact[];
}

export async function loadReleaseFlow(target: ReleaseTarget, deps: LoadFlowDeps): Promise<LoadFlowResult> {
  const db = deps.db ?? defaultDb;
  const { github } = deps;
  const policy = releaseCandidatePolicy(target.releaseConfig);
  if (!policy) {
    return { ok: false, status: 409, error: 'This workspace does not cut frozen release candidates. Turn them on in the workspace release settings.' };
  }
  const repo = target.repoFullName;
  const { sourceBranch, prodBranch } = policy;

  // ── The open candidate, if any ──
  const openPrs = ((await github(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(prodBranch)}&per_page=100`)) ?? []) as any[];
  let candidatePr: any = null;
  let candidateMeta: ReleaseCandidateMeta | null = null;
  for (const pr of openPrs) {
    const cls = classifyReleasePr(target.releaseConfig, {
      headRef: pr.head?.ref,
      baseRef: pr.base?.ref,
      headSha: pr.head?.sha,
      author: pr.user?.login,
      headRepoFullName: pr.head?.repo?.full_name,
      baseRepoFullName: pr.base?.repo?.full_name,
      body: pr.body,
    });
    if (cls.kind === 'candidate') {
      candidatePr = pr;
      candidateMeta = cls.meta;
      break;
    }
  }

  // ── Composition: what the candidate froze, or what dev would ship now ──
  let headSha: string | null = candidateMeta?.sourceSha ?? null;
  if (!headSha) {
    const ref = await github(`/repos/${repo}/git/ref/heads/${encodeURIComponent(sourceBranch)}`);
    headSha = (ref?.object?.sha as string | undefined) ?? null;
  }
  let shipped: Array<{ number: number; title: string; sha: string }> = [];
  let truncated = false;
  if (headSha) {
    const compare = await github(`/repos/${repo}/compare/${encodeURIComponent(prodBranch)}...${headSha}?per_page=250`);
    const commits = (compare?.commits ?? []) as CompareCommit[];
    truncated = typeof compare?.total_commits === 'number' && compare.total_commits > commits.length;
    shipped = firstParentPrs(commits, headSha);
  }

  // PR → mission, through the worker that owns the PR.
  const prNumbers = shipped.map((p) => p.number);
  const owners = prNumbers.length
    ? await db
        .select({ prNumber: workers.prNumber, missionId: tasks.missionId })
        .from(workers)
        .innerJoin(tasks, eq(workers.taskId, tasks.id))
        .where(and(eq(workers.workspaceId, target.workspaceId), inArray(workers.prNumber, prNumbers)))
    : [];
  const missionOfPr = new Map<number, string>();
  for (const o of owners) if (o.prNumber != null && o.missionId) missionOfPr.set(o.prNumber, o.missionId);

  const shippedMissionIds = [...new Set(missionOfPr.values())];
  const missionRows = await db
    .select({
      id: missions.id,
      title: missions.title,
      status: missions.status,
      primaryPrNumber: missions.primaryPrNumber,
      goalCriteria: missions.goalCriteria,
      goalCriteriaState: missions.goalCriteriaState,
    })
    .from(missions)
    .where(
      and(
        eq(missions.workspaceId, target.workspaceId),
        or(
          shippedMissionIds.length ? inArray(missions.id, shippedMissionIds) : undefined,
          and(isNotNull(missions.primaryPrNumber), notInArray(missions.status, [...CLOSED_MISSION_STATUSES])),
        ),
      ),
    );
  const relevant = missionRows;

  const composeMissions: ComposeMission[] = await Promise.all(
    relevant.map(async (m) => {
      const total = m.goalCriteria?.length ?? 0;
      const met = (m.goalCriteriaState?.criteria ?? []).filter((c) => c.verdict === 'pass').length;
      let missionPr: ComposeMission['missionPr'] = null;
      if (m.primaryPrNumber != null) {
        try {
          const pr = await github(`/repos/${repo}/pulls/${m.primaryPrNumber}`);
          // Only a mission PR into the source branch can be included before the cut.
          if (pr && pr.base?.ref === sourceBranch) {
            const open = pr.state === 'open';
            const [runs, reviews] = await Promise.all([
              checkRunsFor(github, repo, pr.head.sha),
              open ? github(`/repos/${repo}/pulls/${m.primaryPrNumber}/reviews?per_page=100`) : Promise.resolve([]),
            ]);
            const latest = latestReviews(reviews ?? []);
            missionPr = {
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              state: pr.merged_at ? 'merged' : open ? 'open' : 'closed',
              approved:
                open &&
                !latest.some((r) => r.state === 'CHANGES_REQUESTED') &&
                latest.some((r) => r.state === 'APPROVED' && r.sha === pr.head.sha),
              checks: summarizeRuns(runs),
            };
          }
        } catch {
          missionPr = null; // unreadable: neither ready nor on dev through this PR
        }
      }
      return { id: m.id, title: m.title, criteria: total > 0 ? { met, total } : null, missionPr };
    }),
  );

  const shippedPrs: ComposePr[] = shipped.map((p) => ({
    number: p.number,
    title: p.title,
    url: `https://github.com/${repo}/pull/${p.number}`,
    mergeSha: p.sha,
    missionId: missionOfPr.get(p.number) ?? null,
  }));
  const composition = groupComposition({ shippedPrs, missions: composeMissions });
  // Before the cut, a mission PR can only be included into dev; once a candidate
  // is frozen, nothing more goes in (a later dev merge needs a new cut or an amend).
  if (candidatePr) {
    composition.ready = [];
    composition.notReady = [];
  }

  // What the open candidate already leaves out, by composition key.
  const revertedShas = new Set((candidateMeta as (ReleaseCandidateMeta & { reverted?: Array<{ sha: string }> }) | null)?.reverted?.map((r) => r.sha) ?? []);
  const leftOut: string[] = [];
  for (const g of composition.onDev) if (g.prs.some((p) => p.mergeSha && revertedShas.has(p.mergeSha))) leftOut.push(g.key);
  for (const o of composition.other) if (o.pr.mergeSha && revertedShas.has(o.pr.mergeSha)) leftOut.push(o.key);
  const selected = [...defaultSelection(composition)].filter((k) => !leftOut.includes(k));

  // ── Candidate review ──
  let candidate: CandidateState | null = null;
  if (candidatePr && candidateMeta) {
    const sha = candidateMeta.candidateSha;
    const [runs, reviews, comments] = await Promise.all([
      checkRunsFor(github, repo, sha),
      github(`/repos/${repo}/pulls/${candidatePr.number}/reviews?per_page=100`),
      github(`/repos/${repo}/issues/${candidatePr.number}/comments?per_page=100`),
    ]);
    const verdict = candidateVerdict({
      candidateSha: sha,
      required: REQUIRED_CANDIDATE_CHECKS,
      checks: toCandidateChecks(runs, REQUIRED_CANDIDATE_CHECKS),
      reviews: latestReviews(reviews ?? []),
    });
    const refusal = latestRefusal(comments ?? []);
    const meta = candidateMeta as ReleaseCandidateMeta & { reverted?: Array<{ sha: string; subject: string }> };
    candidate = {
      prNumber: candidatePr.number,
      url: candidatePr.html_url,
      version: meta.version.replace(/^v/, ''),
      candidateSha: sha,
      sourceSha: meta.sourceSha,
      amendment: meta.amendment ?? 0,
      previousCandidateSha: meta.previousCandidateSha ?? null,
      reverted: meta.reverted ?? [],
      verdict,
      refusal: refusal && refusal.candidateSha === sha ? refusal : null,
      deltaUrl: meta.previousCandidateSha ? `https://github.com/${repo}/compare/${meta.previousCandidateSha}...${sha}` : null,
    };
  }

  // ── The record: who pressed what, newest first ──
  const recordRows = await db
    .select({
      id: releaseFlowSteps.id,
      step: releaseFlowSteps.step,
      outcome: releaseFlowSteps.outcome,
      version: releaseFlowSteps.version,
      candidateSha: releaseFlowSteps.candidateSha,
      prNumber: releaseFlowSteps.prNumber,
      detail: releaseFlowSteps.detail,
      occurredAt: releaseFlowSteps.occurredAt,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(releaseFlowSteps)
    .leftJoin(users, eq(users.id, releaseFlowSteps.actorUserId))
    .where(eq(releaseFlowSteps.workspaceId, target.workspaceId))
    .orderBy(desc(releaseFlowSteps.occurredAt))
    .limit(30);
  const record: FlowRecordEntry[] = recordRows.map((r) => ({
    id: r.id,
    step: r.step,
    outcome: r.outcome,
    actor: r.actorName || r.actorEmail || 'Someone',
    at: r.occurredAt.toISOString(),
    version: r.version,
    candidateSha: r.candidateSha,
    prNumber: r.prNumber,
    detail: r.detail ?? null,
  }));

  // ── The merged candidate and what production runs ──
  let merged: MergedCandidateState | null = null;
  if (!candidate) {
    const closed = ((await github(`/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(prodBranch)}&sort=updated&direction=desc&per_page=30`)) ?? []) as any[];
    const last = closed
      .filter((p) => p.merged_at && p.merge_commit_sha)
      .map((p) => ({
        p,
        cls: classifyReleasePr(target.releaseConfig, {
          headRef: p.head?.ref,
          baseRef: p.base?.ref,
          headSha: p.head?.sha,
          author: p.user?.login,
          headRepoFullName: p.head?.repo?.full_name,
          baseRepoFullName: p.base?.repo?.full_name,
          body: p.body,
        }),
      }))
      .filter((x) => x.cls.kind === 'candidate')
      .sort((a, b) => Date.parse(b.p.merged_at) - Date.parse(a.p.merged_at))[0];
    if (last && last.cls.kind === 'candidate') {
      const version = last.cls.version;
      const confirmed = record.some((r) => r.step === 'confirm_production' && r.outcome === 'succeeded' && r.version === version);
      const mergeSha = last.p.merge_commit_sha as string;
      const url = target.releaseConfig?.verificationUrl;
      const deployedSha = url ? await deps.deployedSha(url) : null;
      let contains: boolean | null = null;
      if (deployedSha && deployedSha !== mergeSha) {
        try {
          const cmp = await github(`/repos/${repo}/compare/${mergeSha}...${deployedSha}`);
          contains = cmp?.status === 'ahead' || cmp?.status === 'identical';
        } catch {
          contains = null;
        }
      }
      merged = {
        prNumber: last.p.number,
        url: last.p.html_url,
        version,
        mergeSha,
        mergedAt: last.p.merged_at,
        deployedSha,
        production: productionState({ mergeSha, deployedSha, deployedContainsMerge: contains }),
        confirmed,
      };
    }
  }

  const awaitingConfirm = merged && !merged.confirmed ? merged : null;
  const step: FlowStep = awaitingConfirm
    ? awaitingConfirm.production === 'released'
      ? 'released'
      : 'release'
    : flowStep({ hasCandidate: !!candidate, production: 'not_merged' });

  const missionsCount = composition.onDev.filter((g) => selected.includes(g.key)).length;
  const otherCount = composition.other.filter((o) => selected.includes(o.key)).length;
  // A merged candidate's composition is what the Release press recorded; dev has moved on since.
  const releasedCounts = awaitingConfirm
    ? (record.find((r) => r.step === 'release' && r.outcome === 'succeeded' && r.version === awaitingConfirm.version)?.detail as
        | { missions?: number; other?: number }
        | undefined)
    : undefined;
  const lede = releaseLede({
    version: candidate?.version ?? awaitingConfirm?.version ?? null,
    step,
    missions: awaitingConfirm ? releasedCounts?.missions : missionsCount,
    other: awaitingConfirm ? releasedCounts?.other : otherCount,
    verdict: candidate?.verdict ?? null,
  });

  return {
    ok: true,
    view: {
      workspace: { id: target.workspaceId, name: target.workspaceName, repoFullName: repo },
      sourceBranch,
      prodBranch,
      compositionSha: headSha,
      composition,
      defaultSelected: selected,
      leftOut,
      candidate,
      merged,
      step,
      lede,
      counts: { missions: missionsCount, other: otherCount },
      record,
      truncated,
    },
  };
}
