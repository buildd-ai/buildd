/**
 * Composition attestation for release and mission integration PRs
 * (docs/specs/workflow-state-kernel.md §5.9).
 *
 * A composed PR (a release PR, a mission's integration PR into trunk) is built
 * from changes that were each already reviewed at their own head. Instead of a
 * second full review, the kernel proves mechanically which of its commits are
 * those reviewed changes, which are deterministic release artifacts (the
 * version bump, the CHANGELOG promotion), and which are neither. Only the
 * "neither" part, the novel delta, is reviewed again. Nothing here lends the
 * aggregate head a verdict: an accepted attestation marks the head
 * composition-covered (§8, `headCoverage` → 'composition'), and CI still gates
 * the aggregate through the unchanged landing rails (T15).
 *
 * `buildCompositionAttestation` is pure. `collectComposition` is the GitHub
 * and ledger read that feeds it. Both fail closed: anything the check cannot
 * see (a truncated compare, an unreadable commit, an empty constituent set)
 * makes the result `unverifiable`, which claims nothing and leaves the normal
 * full review in place.
 */
import { sql } from 'drizzle-orm';
import { isReleaseBranchPr } from '@buildd/core/release-strategy';
import type { Exec } from './kernel';
import type { CompositionAttestation, CompositionConstituent, ConstituentEvidence, NovelDelta, RoundStatus, Verdict } from './types';

// ── Which PRs are composed ──────────────────────────────────────────────────

export interface CompositionPrRefs {
  headRef: string | null;
  baseRef: string | null;
  /** The owner task's mission working (integration) branch, when it has one. */
  missionWorkingBranch?: string | null;
  releaseConfig?: Parameters<typeof isReleaseBranchPr>[0];
}

/**
 * A mission's integration PR (its working branch merging into trunk) or a
 * release PR (releaseBranch → prodBranch). Every other PR, including a task PR
 * INTO a mission branch, is ordinary and stays exact-head bound.
 */
export function isCompositionPr(r: CompositionPrRefs): boolean {
  const head = r.headRef?.trim() || null;
  const base = r.baseRef?.trim() || null;
  if (!head || !base || head === base) return false;
  if (r.missionWorkingBranch && head === r.missionWorkingBranch.trim()) return true;
  return isReleaseBranchPr(r.releaseConfig ?? null, { headRef: head, baseRef: base });
}

// ── Deterministic release artifacts ─────────────────────────────────────────

/** Commit subjects the release automation writes (release.yml, release-refresh.yml, release-bump.ts). */
export const RELEASE_ARTIFACT_SUBJECTS: RegExp[] = [
  /^chore: bump version to v\d+\.\d+\.\d+/,
  /^docs: promote CHANGELOG for upcoming release$/,
  /^Release v\d+\.\d+\.\d+$/,
];

/** The only paths a release artifact commit may touch. */
export function isReleaseArtifactPath(p: string): boolean {
  return p === 'CHANGELOG.md' || p === 'bun.lock' || p === 'package.json' || p.endsWith('/package.json');
}

export function isReleaseArtifactCommit(c: Pick<CommitFacts, 'message' | 'parents' | 'files'>): boolean {
  if (c.parents.length !== 1 || !c.files || c.files.length === 0) return false;
  const subject = c.message.split('\n')[0].trim();
  return RELEASE_ARTIFACT_SUBJECTS.some((re) => re.test(subject)) && c.files.every(isReleaseArtifactPath);
}

// ── Pure builder ────────────────────────────────────────────────────────────

export interface CommitFacts {
  sha: string;
  parents: string[];
  message: string;
  /** Paths the commit changed against its first parent; null = unreadable or truncated. */
  files: string[] | null;
  /** For a merge commit: every non-first parent is already contained in the base. */
  mergeParentsInBase?: boolean;
}

export interface ConstituentDelivery {
  deliveryId: string;
  approvedHeads: string[];
  rounds: Array<{ id: string; headSha: string; status: RoundStatus; effectiveVerdict: Verdict | null }>;
}

export interface ConstituentPr {
  prNumber: number;
  /** The PR's head when it merged (what GitHub squashed or merged). */
  mergedHeadSha: string;
  /** The PR's kernel delivery; absent when its review ran on the legacy path. */
  delivery?: ConstituentDelivery | null;
}

export interface CompositionInput {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  aggregateHeadSha: string;
  commits: CommitFacts[] | null;
  /** Paths of the aggregate diff (base...head); null = truncated. */
  aggregateFiles: string[] | null;
  /** commit sha → the merged PR it landed, or null when none. */
  constituentsByCommit: Record<string, ConstituentPr | null>;
  verifier?: string;
  now?: string;
}

export interface CompositionResult {
  attestation: CompositionAttestation;
  constituentsEvidence: ConstituentEvidence[];
  /** Why each non-constituent commit counted as novel (for the reviewer and the activity trail). */
  novelCommits: Array<{ sha: string; reason: string; paths: string[] }>;
}

/** The decided approve round that covers `head` in a constituent's delivery. */
function coveringRound(dl: ConstituentDelivery, head: string) {
  const approves = dl.rounds.filter((r) => r.status === 'decided' && r.effectiveVerdict === 'approve');
  const exact = approves.find((r) => r.headSha === head);
  if (exact) return { round: exact, equivalent: [] as string[] };
  // The merged head is a recorded content-equivalent of an approved head (§8.3 carry-forward).
  if (dl.approvedHeads.includes(head)) {
    const cited = approves.filter((r) => dl.approvedHeads.includes(r.headSha)).sort((a, b) => a.headSha.localeCompare(b.headSha))[0];
    if (cited) return { round: cited, equivalent: [head] };
  }
  return null;
}

export function buildCompositionAttestation(input: CompositionInput): CompositionResult {
  const constituents: CompositionConstituent[] = [];
  const evidence: ConstituentEvidence[] = [];
  const novel: CompositionResult['novelCommits'] = [];
  let unverifiable: string | null = null;

  if (!input.commits) unverifiable = 'commit_list_truncated';
  if (!input.aggregateFiles) unverifiable = unverifiable ?? 'aggregate_diff_truncated';

  const covered = new Set<string>();
  for (const c of input.commits ?? []) {
    if (!c.files) { unverifiable = unverifiable ?? `commit_unreadable:${c.sha.slice(0, 12)}`; continue; }
    c.files.forEach((f) => covered.add(f));
    if (c.parents.length > 1) {
      // A merge commit. Bringing the base in adds nothing of its own except a
      // conflict resolution, which shows only in files both sides changed: those
      // are novel. A merge of anything not already in the base is wholly novel.
      const aggregate = new Set(input.aggregateFiles ?? []);
      const paths = c.mergeParentsInBase ? c.files.filter((f) => aggregate.has(f)) : c.files;
      if (paths.length) novel.push({ sha: c.sha, reason: c.mergeParentsInBase ? 'merge_resolution' : 'merge_of_unreviewed_history', paths });
      continue;
    }
    if (isReleaseArtifactCommit(c)) continue;
    const pr = input.constituentsByCommit[c.sha] ?? null;
    if (!pr) { if (c.files.length) novel.push({ sha: c.sha, reason: 'direct_commit', paths: c.files }); continue; }
    const cov = pr.delivery ? coveringRound(pr.delivery, pr.mergedHeadSha) : null;
    if (!pr.delivery || !cov) {
      if (c.files.length) novel.push({ sha: c.sha, reason: pr.delivery ? `pr_${pr.prNumber}_not_approved_at_merged_head` : `pr_${pr.prNumber}_no_kernel_review`, paths: c.files });
      continue;
    }
    constituents.push({
      deliveryId: pr.delivery.deliveryId,
      roundId: cov.round.id,
      prNumber: pr.prNumber,
      reviewedHeadSha: cov.round.headSha,
      equivalentHeadShas: cov.equivalent,
      landedSha: pr.mergedHeadSha,
    });
    evidence.push({
      roundId: cov.round.id,
      roundHeadSha: cov.round.headSha,
      roundStatus: cov.round.status,
      effectiveVerdict: cov.round.effectiveVerdict,
      deliveryApprovedHeads: pr.delivery.approvedHeads,
    });
  }

  // The aggregate must be explained by its commits: a path in the aggregate
  // diff that no commit touched means the compare is not what we read.
  if (!unverifiable && input.aggregateFiles && input.aggregateFiles.some((f) => !covered.has(f))) unverifiable = 'aggregate_not_explained_by_commits';
  if (!unverifiable && constituents.length === 0) unverifiable = 'no_reviewed_constituents';

  // Only paths still present in the aggregate diff are owed a review (a novel
  // edit later reverted by a constituent leaves nothing to look at).
  const aggregate = new Set(input.aggregateFiles ?? []);
  const novelPaths = [...new Set(novel.flatMap((n) => n.paths))].filter((p) => aggregate.has(p)).sort();
  const novelDelta: NovelDelta = unverifiable
    ? { result: 'unverifiable', reason: unverifiable }
    : novelPaths.length ? { result: 'present', paths: novelPaths } : { result: 'none' };

  return {
    attestation: {
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      baseSha: input.baseSha,
      aggregateHeadSha: input.aggregateHeadSha,
      method: 'patch_set_equal',
      verifiedAt: input.now ?? new Date().toISOString(),
      verifier: input.verifier ?? 'kernel',
      constituents,
      novelDelta,
    },
    constituentsEvidence: evidence,
    novelCommits: novel,
  };
}

// ── GitHub + ledger collector ───────────────────────────────────────────────

/** GitHub caps a compare at 250 commits and a diff at 300 files; at the cap the list may be cut. */
export const COMPARE_COMMIT_CAP = 250;
export const DIFF_FILE_CAP = 300;

export type GithubApi = (installationId: number, path: string, options?: RequestInit) => Promise<unknown>;

interface GhCompare {
  merge_base_commit?: { sha?: string };
  base_commit?: { sha?: string };
  total_commits?: number;
  commits?: Array<{ sha: string; parents?: Array<{ sha: string }>; commit?: { message?: string } }>;
  files?: Array<{ filename: string }>;
}

export function deliveryRoundsSql(workspaceId: string, repoFullName: string, prNumbers: number[]) {
  return sql`-- workflow:composition_constituents
SELECT d.id, d.pr_number, d.approved_heads,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'head_sha', r.head_sha, 'status', r.status, 'effective_verdict', r.effective_verdict))
     FROM workflow_review_rounds r WHERE r.delivery_id = d.id), '[]'::jsonb) AS rounds
FROM workflow_deliveries d
WHERE d.workspace_id = ${workspaceId}::uuid AND d.repo_full_name = ${repoFullName}::text AND d.authority = 'kernel'
  AND d.pr_number IN (SELECT (jsonb_array_elements_text(${JSON.stringify(prNumbers)}::jsonb))::int)`;
}

export async function collectComposition(p: {
  api: GithubApi;
  exec: Exec;
  installationId: number;
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  aggregateHeadSha: string;
}): Promise<CompositionResult> {
  const { api, installationId: inst, repoFullName: repo } = p;
  const cmp = (await api(inst, `/repos/${repo}/compare/${encodeURIComponent(p.baseRef)}...${p.aggregateHeadSha}?per_page=${COMPARE_COMMIT_CAP}`)) as GhCompare | null;
  const baseSha = cmp?.merge_base_commit?.sha ?? '';
  const baseHead = cmp?.base_commit?.sha ?? baseSha;
  const rawCommits = cmp?.commits ?? [];
  const truncatedCommits = !cmp || (cmp.total_commits ?? rawCommits.length) > rawCommits.length || rawCommits.length >= COMPARE_COMMIT_CAP;
  const aggregateFiles = cmp?.files && cmp.files.length < DIFF_FILE_CAP ? cmp.files.map((f) => f.filename) : null;

  const commits: CommitFacts[] = [];
  const prsByCommit: Record<string, { prNumber: number; mergedHeadSha: string } | null> = {};
  for (const c of rawCommits) {
    const parents = (c.parents ?? []).map((x) => x.sha);
    let files: string[] | null = null;
    try {
      const full = (await api(inst, `/repos/${repo}/commits/${c.sha}`)) as { files?: Array<{ filename: string }> } | null;
      files = full?.files && full.files.length < DIFF_FILE_CAP ? full.files.map((f) => f.filename) : null;
    } catch { files = null; }
    let mergeParentsInBase: boolean | undefined;
    if (parents.length > 1) {
      mergeParentsInBase = true;
      for (const parent of parents.slice(1)) {
        try {
          const rel = (await api(inst, `/repos/${repo}/compare/${parent}...${baseHead}`)) as { status?: string } | null;
          if (!(rel?.status === 'ahead' || rel?.status === 'identical')) mergeParentsInBase = false;
        } catch { mergeParentsInBase = false; }
      }
    } else {
      try {
        const pulls = (await api(inst, `/repos/${repo}/commits/${c.sha}/pulls`)) as Array<{ number: number; merged_at?: string | null; base?: { ref?: string }; head?: { sha?: string } }> | null;
        const hit = (pulls ?? []).find((x) => x.merged_at && x.base?.ref === p.headRef && x.head?.sha);
        prsByCommit[c.sha] = hit ? { prNumber: hit.number, mergedHeadSha: hit.head!.sha! } : null;
      } catch { prsByCommit[c.sha] = null; }
    }
    commits.push({ sha: c.sha, parents, message: c.commit?.message ?? '', files, mergeParentsInBase });
  }

  const prNumbers = [...new Set(Object.values(prsByCommit).filter(Boolean).map((x) => x!.prNumber))];
  const deliveries = new Map<number, ConstituentDelivery>();
  if (prNumbers.length) {
    const rows = ((await p.exec(deliveryRoundsSql(p.workspaceId, repo, prNumbers))).rows ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      deliveries.set(Number(r.pr_number), {
        deliveryId: String(r.id),
        approvedHeads: (r.approved_heads as string[] | null) ?? [],
        rounds: ((r.rounds as Array<Record<string, unknown>>) ?? []).map((x) => ({
          id: String(x.id), headSha: String(x.head_sha), status: x.status as RoundStatus, effectiveVerdict: (x.effective_verdict ?? null) as Verdict | null,
        })),
      });
    }
  }
  const constituentsByCommit: Record<string, ConstituentPr | null> = {};
  for (const [sha, pr] of Object.entries(prsByCommit)) {
    constituentsByCommit[sha] = pr ? { ...pr, delivery: deliveries.get(pr.prNumber) ?? null } : null;
  }

  return buildCompositionAttestation({
    repoFullName: repo,
    prNumber: p.prNumber,
    baseSha,
    aggregateHeadSha: p.aggregateHeadSha,
    commits: truncatedCommits ? null : commits,
    aggregateFiles,
    constituentsByCommit,
  });
}
