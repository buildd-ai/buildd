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
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isCiVerifiedGeneratedPath, isMigrationSqlPath } from '@buildd/core/generated-artifacts';
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
  /**
   * The trunk a mission branch refresh merges in, when the owner task is that
   * refresh (`integrationRefreshOf` its context); null for every other task.
   */
  refreshTrunk?: string | null;
}

/**
 * A mission's integration PR (its working branch merging into trunk), a
 * release PR (releaseBranch → prodBranch), or a mission branch refresh PR
 * (trunk merged into the mission's working branch, opened by the refresh
 * conflict task). Every other PR, including an ordinary task PR INTO a mission
 * branch, is ordinary and stays exact-head bound.
 */
export function isCompositionPr(r: CompositionPrRefs): boolean {
  const head = r.headRef?.trim() || null;
  const base = r.baseRef?.trim() || null;
  if (!head || !base || head === base) return false;
  if (r.missionWorkingBranch && head === r.missionWorkingBranch.trim()) return true;
  if (r.refreshTrunk && r.missionWorkingBranch && base === r.missionWorkingBranch.trim()) return true;
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

/** One file of a diff as GitHub returns it in a commit's or a compare's `files[]`. */
export interface FileDiff {
  filename: string;
  status?: string | null;
  previousFilename?: string | null;
  /** The unified diff hunks; GitHub omits it for binary and very large files. */
  patch?: string | null;
  /** The file's blob after the change (GitHub's `files[].sha`). */
  blobSha?: string | null;
}

export interface PatchId {
  /** sha256 over every file's normalized patch; '' when any file is unreadable. */
  id: string;
  /** path → that file's normalized patch-id. */
  perFile: Map<string, string>;
  /** Files whose change cannot be read (no patch and no blob). */
  unreadable: string[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A patch-id in the sense of `git patch-id`: what a diff changes, independent
 * of where. Hunk headers (line numbers) and context lines are dropped; every
 * added and removed line is kept, in order, with trailing whitespace trimmed.
 * Two diffs with the same id make the same change; any differing added or
 * removed line, file, rename or mode makes the ids differ. A file GitHub
 * gives no patch for (binary, too large) is identified by its resulting blob,
 * and one with neither is unreadable, which fails the proof closed.
 */
export function patchIdOf(diff: FileDiff[]): PatchId {
  const perFile = new Map<string, string>();
  const unreadable: string[] = [];
  for (const f of diff) {
    const status = f.status === 'changed' ? 'modified' : (f.status ?? 'modified');
    const head = `${status} ${f.previousFilename ?? ''}->${f.filename}`;
    let body: string;
    if (typeof f.patch === 'string' && f.patch.length > 0) {
      body = f.patch.split('\n')
        .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
        .map((l) => l.replace(/\s+$/, ''))
        .join('\n');
    } else if (f.blobSha) {
      body = `blob ${f.blobSha}`;
    } else if (status === 'renamed' || status === 'removed') {
      body = ''; // a pure rename or a deletion is fully described by its header
    } else {
      unreadable.push(f.filename);
      continue;
    }
    perFile.set(f.filename, sha256(`${head}\n${body}`));
  }
  const id = unreadable.length || perFile.size === 0
    ? ''
    : sha256([...perFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, h]) => `${p} ${h}`).join('\n'));
  return { id, perFile, unreadable: unreadable.sort() };
}

/** Paths whose change differs between two diffs (present in one only, or a different patch). */
function differingPaths(a: PatchId, b: PatchId): string[] {
  const paths = new Set([...a.perFile.keys(), ...b.perFile.keys()]);
  return [...paths].filter((p) => a.perFile.get(p) !== b.perFile.get(p)).sort();
}

export interface CommitFacts {
  sha: string;
  parents: string[];
  message: string;
  /** Paths the commit changed against its first parent; null = unreadable or truncated. */
  files: string[] | null;
  /** The commit's own diff against its first parent, with patches; null/absent = unreadable. */
  diff?: FileDiff[] | null;
  /** For a merge commit: every non-first parent is already contained in the base. */
  mergeParentsInBase?: boolean;
  /**
   * A refresh composition's merge of trunk (two parents, the second on trunk):
   * the four trees that decide what the merge itself changed. null = a tree
   * was unreadable or truncated; absent = not such a merge.
   */
  refreshMerge?: RefreshMergeTrees | null;
}

/** path → `${mode} ${sha}` of one commit's whole tree (blobs and submodules). */
export type TreeMap = Record<string, string>;

export interface RefreshMergeTrees {
  /** The merge base of the two parents. */
  base: TreeMap;
  /** The first parent: the mission side. */
  ours: TreeMap;
  /** The second parent: the trunk side. */
  theirs: TreeMap;
  /** The merge commit itself. */
  merged: TreeMap;
}

/**
 * The paths a merge decided rather than inherited, from whole trees (no file
 * cap): every path both sides changed (the resolution, including a side taken
 * whole, which drops the other side's change), and every path where the result
 * is not what the one side that changed it, or neither side, left there (an
 * edit made in the merge, or a dropped change). A path only one side changed,
 * taken as that side has it, is inherited: its change was reviewed on that side.
 */
export function classifyRefreshMerge(t: RefreshMergeTrees): string[] {
  const paths = new Set([...Object.keys(t.base), ...Object.keys(t.ours), ...Object.keys(t.theirs), ...Object.keys(t.merged)]);
  const novel: string[] = [];
  for (const p of paths) {
    const b = t.base[p], o = t.ours[p], th = t.theirs[p], m = t.merged[p];
    const inherited = o === th ? m === o
      : o === b ? m === th
      : th === b ? m === o
      : false;
    if (!inherited) novel.push(p);
  }
  return novel.sort();
}

/**
 * Migrations the merge only moved: a mission-side `.sql` the merge no longer
 * has, paired with a new `.sql` in the merge (on neither side) holding the
 * same blob. That is the generated-conflict resolver renumbering this
 * branch's migration past trunk's (scripts/resolve-generated-conflicts.ts),
 * already reviewed on the mission side at its old index. Matched one to one;
 * anything else under drizzle/ that the merge decided stays novel, since a
 * hand-written step there is invisible to CI.
 */
export function renumberedMigrations(t: RefreshMergeTrees): Set<string> {
  const left = Object.keys(t.ours).filter((p) => isMigrationSqlPath(p) && t.merged[p] === undefined);
  const arrived = Object.keys(t.merged)
    .filter((p) => isMigrationSqlPath(p) && t.ours[p] === undefined && t.theirs[p] === undefined)
    .sort();
  const out = new Set<string>();
  const used = new Set<string>();
  for (const p of arrived) {
    const q = left.find((c) => !used.has(c) && t.ours[c] === t.merged[p]);
    if (!q) continue;
    used.add(q);
    out.add(p);
    out.add(q);
  }
  return out;
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
  /**
   * landed commit sha → the diff its constituent's REVIEWED head makes against
   * that commit's parent (GitHub `compare/{parent}...{reviewedHead}`), read
   * independently of the commit itself. Absent or null = unreadable.
   */
  reviewedDiffs?: Record<string, FileDiff[] | null>;
  /**
   * Set for a mission branch refresh PR: its constituents are trunk PRs, a
   * merge of trunk is read from `refreshMerge`, and of what that merge decided,
   * the files CI regenerates and compares (`isCiVerifiedGeneratedPath`) are not
   * owed a review.
   */
  refresh?: { trunk: string } | null;
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
export function coveringRound(dl: ConstituentDelivery, head: string) {
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
  // What a refresh's merge decided is owed a review even where the aggregate
  // diff shows nothing: taking the mission side whole drops a trunk change
  // without leaving a line in the PR diff.
  const resolutionPaths = new Set<string>();
  for (const c of input.commits ?? []) {
    if (!c.files) { unverifiable = unverifiable ?? `commit_unreadable:${c.sha.slice(0, 12)}`; continue; }
    c.files.forEach((f) => covered.add(f));
    if (c.parents.length > 1 && input.refresh && !c.mergeParentsInBase && c.refreshMerge !== undefined) {
      if (!c.refreshMerge) { unverifiable = unverifiable ?? `refresh_merge_unreadable:${c.sha.slice(0, 12)}`; continue; }
      const moved = renumberedMigrations(c.refreshMerge);
      const paths = classifyRefreshMerge(c.refreshMerge).filter((f) => !isCiVerifiedGeneratedPath(f) && !moved.has(f));
      paths.forEach((f) => resolutionPaths.add(f));
      if (paths.length) novel.push({ sha: c.sha, reason: 'refresh_merge_resolution', paths });
      continue;
    }
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
    // The proof: what this commit actually changed must be what was reviewed.
    // GitHub's commit→PR association only says which PR to compare against.
    const reviewedDiff = input.reviewedDiffs?.[c.sha] ?? null;
    if (!c.diff) { unverifiable = unverifiable ?? `landed_patch_unreadable:${c.sha.slice(0, 12)}`; continue; }
    if (!reviewedDiff) { unverifiable = unverifiable ?? `reviewed_patch_unreadable:${c.sha.slice(0, 12)}`; continue; }
    const landed = patchIdOf(c.diff);
    const reviewed = patchIdOf(reviewedDiff);
    if (landed.unreadable.length || reviewed.unreadable.length) {
      unverifiable = unverifiable ?? `patch_unreadable:${c.sha.slice(0, 12)}:${[...landed.unreadable, ...reviewed.unreadable][0]}`;
      continue;
    }
    if (!landed.id || landed.id !== reviewed.id) {
      // Owed a review: the files whose landed change differs from the reviewed
      // one (a conflict resolved while merging, a hand edit in the squash). A
      // file the reviewed head changed but that never landed still means this
      // commit is not the reviewed change, so the whole commit is novel then.
      const differ = differingPaths(landed, reviewed);
      const landedDiffer = differ.filter((p) => landed.perFile.has(p));
      novel.push({ sha: c.sha, reason: `pr_${pr.prNumber}_landed_patch_differs`, paths: landedDiffer.length ? landedDiffer : c.files });
      continue;
    }
    constituents.push({
      deliveryId: pr.delivery.deliveryId,
      roundId: cov.round.id,
      prNumber: pr.prNumber,
      reviewedHeadSha: cov.round.headSha,
      equivalentHeadShas: cov.equivalent,
      mergedHeadSha: pr.mergedHeadSha,
      landedSha: c.sha,
      landedPatchId: landed.id,
      reviewedPatchId: reviewed.id,
    });
    evidence.push({
      roundId: cov.round.id,
      deliveryId: pr.delivery.deliveryId,
      prNumber: pr.prNumber,
      repoFullName: input.repoFullName,
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
  const novelPaths = [...new Set(novel.flatMap((n) => n.paths))].filter((p) => aggregate.has(p) || resolutionPaths.has(p)).sort();
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

type GhFiles = { files?: Array<{ filename: string; status?: string; previous_filename?: string; patch?: string; sha?: string }> };

/** A commit's or compare's `files[]` as diffs; null when absent or at GitHub's file cap (the list may be cut). */
function toFileDiffs(r: GhFiles | null): FileDiff[] | null {
  if (!r?.files || r.files.length >= DIFF_FILE_CAP) return null;
  return r.files.map((f) => ({ filename: f.filename, status: f.status ?? null, previousFilename: f.previous_filename ?? null, patch: f.patch ?? null, blobSha: f.sha ?? null }));
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
  /** The trunk a mission branch refresh PR merges in (see `isCompositionPr`); absent otherwise. */
  refreshTrunk?: string | null;
}): Promise<CompositionResult> {
  const { api, installationId: inst, repoFullName: repo } = p;
  const cmp = (await api(inst, `/repos/${repo}/compare/${encodeURIComponent(p.baseRef)}...${p.aggregateHeadSha}?per_page=${COMPARE_COMMIT_CAP}`)) as GhCompare | null;
  const baseSha = cmp?.merge_base_commit?.sha ?? '';
  const baseHead = cmp?.base_commit?.sha ?? baseSha;
  const rawCommits = cmp?.commits ?? [];
  const truncatedCommits = !cmp || (cmp.total_commits ?? rawCommits.length) > rawCommits.length || rawCommits.length >= COMPARE_COMMIT_CAP;
  const aggregateFiles = cmp?.files && cmp.files.length < DIFF_FILE_CAP ? cmp.files.map((f) => f.filename) : null;

  const refreshTrunk = p.refreshTrunk?.trim() || null;
  // A refresh's constituents landed on trunk; anything else's landed on its head branch.
  const constituentBase = refreshTrunk ?? p.headRef;
  const commits: CommitFacts[] = [];
  const prsByCommit: Record<string, { prNumber: number; mergedHeadSha: string } | null> = {};
  for (const c of rawCommits) {
    const parents = (c.parents ?? []).map((x) => x.sha);
    let diff: FileDiff[] | null = null;
    try {
      diff = toFileDiffs((await api(inst, `/repos/${repo}/commits/${c.sha}`)) as GhFiles | null);
    } catch { diff = null; }
    const files = diff ? diff.map((f) => f.filename) : null;
    let mergeParentsInBase: boolean | undefined;
    if (parents.length > 1) {
      mergeParentsInBase = true;
      for (const parent of parents.slice(1)) {
        try {
          const rel = (await api(inst, `/repos/${repo}/compare/${parent}...${baseHead}`)) as { status?: string } | null;
          if (!(rel?.status === 'ahead' || rel?.status === 'identical')) mergeParentsInBase = false;
        } catch { mergeParentsInBase = false; }
      }
      if (refreshTrunk && !mergeParentsInBase && parents.length === 2 && await onRef(api, inst, repo, parents[1], refreshTrunk)) {
        commits.push({ sha: c.sha, parents, message: c.commit?.message ?? '', files, diff, mergeParentsInBase, refreshMerge: await readRefreshMerge(api, inst, repo, parents[0], parents[1], c.sha) });
        continue;
      }
    } else {
      try {
        const pulls = (await api(inst, `/repos/${repo}/commits/${c.sha}/pulls`)) as Array<{ number: number; merged_at?: string | null; base?: { ref?: string }; head?: { sha?: string } }> | null;
        const hit = (pulls ?? []).find((x) => x.merged_at && x.base?.ref === constituentBase && x.head?.sha);
        prsByCommit[c.sha] = hit ? { prNumber: hit.number, mergedHeadSha: hit.head!.sha! } : null;
      } catch { prsByCommit[c.sha] = null; }
    }
    commits.push({ sha: c.sha, parents, message: c.commit?.message ?? '', files, diff, mergeParentsInBase });
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

  // The second, independent read: what each constituent's reviewed head
  // changes against the landed commit's parent (the three-dot compare diffs
  // from their merge base, i.e. the PR's own change as it was reviewed).
  const reviewedDiffs: Record<string, FileDiff[] | null> = {};
  for (const c of commits) {
    const pr = constituentsByCommit[c.sha];
    const cov = pr?.delivery ? coveringRound(pr.delivery, pr.mergedHeadSha) : null;
    if (!cov || c.parents.length !== 1) continue;
    try {
      reviewedDiffs[c.sha] = toFileDiffs((await api(inst, `/repos/${repo}/compare/${c.parents[0]}...${cov.round.headSha}`)) as GhFiles | null);
    } catch { reviewedDiffs[c.sha] = null; }
  }

  return buildCompositionAttestation({
    repoFullName: repo,
    prNumber: p.prNumber,
    baseSha,
    aggregateHeadSha: p.aggregateHeadSha,
    commits: truncatedCommits ? null : commits,
    aggregateFiles,
    constituentsByCommit,
    reviewedDiffs,
    refresh: refreshTrunk ? { trunk: refreshTrunk } : null,
  });
}

/** Is `sha` contained in `ref`? Unreadable = no, which reads the merge as wholly novel. */
async function onRef(api: GithubApi, inst: number, repo: string, sha: string, ref: string): Promise<boolean> {
  try {
    const rel = (await api(inst, `/repos/${repo}/compare/${sha}...${ref.split('/').map(encodeURIComponent).join('/')}`)) as { status?: string } | null;
    return rel?.status === 'ahead' || rel?.status === 'identical';
  } catch { return false; }
}

/** One commit's whole tree; null when unreadable or truncated (fails the proof closed). */
async function readTree(api: GithubApi, inst: number, repo: string, commitSha: string): Promise<TreeMap | null> {
  try {
    const commit = (await api(inst, `/repos/${repo}/git/commits/${commitSha}`)) as { tree?: { sha?: string } } | null;
    const treeSha = commit?.tree?.sha;
    if (!treeSha) return null;
    const tree = (await api(inst, `/repos/${repo}/git/trees/${treeSha}?recursive=1`)) as { truncated?: boolean; tree?: Array<{ path: string; mode: string; type: string; sha: string }> } | null;
    if (!tree?.tree || tree.truncated) return null;
    const map: TreeMap = {};
    for (const e of tree.tree) if (e.type !== 'tree') map[e.path] = `${e.mode} ${e.sha}`;
    return map;
  } catch { return null; }
}

/** The four trees of a merge of trunk into a mission branch; null if any is unreadable. */
async function readRefreshMerge(api: GithubApi, inst: number, repo: string, ours: string, theirs: string, merged: string): Promise<RefreshMergeTrees | null> {
  let mergeBase: string | undefined;
  try {
    mergeBase = ((await api(inst, `/repos/${repo}/compare/${ours}...${theirs}`)) as GhCompare | null)?.merge_base_commit?.sha;
  } catch { return null; }
  if (!mergeBase) return null;
  const [base, o, t, m] = await Promise.all([mergeBase, ours, theirs, merged].map((sha) => readTree(api, inst, repo, sha)));
  return base && o && t && m ? { base, ours: o, theirs: t, merged: m } : null;
}
