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
import { isCiVerifiedGeneratedPath, isMigrationSqlPath, pairMovedMigrations } from '@buildd/core/generated-artifacts';
import { classifyReleasePr, releaseConstituentBase, type ReleasePrFacts } from '@buildd/core/release-candidate';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import type { Exec } from './kernel';
import type { CompositionAttestation, CompositionConstituent, ConstituentEvidence, DeliveryState, NovelDelta, RoundStatus, Verdict } from './types';

// ── Which PRs are composed ──────────────────────────────────────────────────

export interface CompositionPrRefs {
  headRef: string | null;
  baseRef: string | null;
  /** The owner task's mission working (integration) branch, when it has one. */
  missionWorkingBranch?: string | null;
  releaseConfig?: WorkspaceReleaseConfig | null;
  /**
   * The rest of the live PR, which a frozen release candidate needs to prove
   * where it came from (author, body metadata, head sha, same repo); see
   * `classifyReleasePr`. Without them a candidate-shaped PR is ordinary.
   */
  pr?: Omit<ReleasePrFacts, 'headRef' | 'baseRef'>;
  /**
   * The trunk a mission branch refresh merges in, when the owner task is that
   * refresh (`integrationRefreshOf` its context); null for every other task.
   */
  refreshTrunk?: string | null;
}

/**
 * A mission's integration PR (its working branch merging into trunk), a
 * release PR (the legacy releaseBranch → prodBranch, or a trusted frozen
 * candidate such as release/v1.2.3 → prodBranch), or a mission branch refresh
 * PR (trunk merged into the mission's working branch, opened by the refresh
 * conflict task). Every other PR, including an ordinary task PR INTO a mission
 * branch and a candidate-shaped PR that fails provenance, is ordinary and
 * stays exact-head bound.
 */
export function isCompositionPr(r: CompositionPrRefs): boolean {
  return compositionConstituentBase(r) !== null;
}

/**
 * Where a composed PR's constituent PRs merged, or null when it is not a
 * composed PR. A mission integration PR's constituents merged into its head
 * (the working branch), a refresh's into the trunk it brings in, a legacy
 * release PR's into its head (dev), and a release candidate's into its source
 * branch (dev): a candidate branch is cut, never merged into.
 */
export function compositionConstituentBase(r: CompositionPrRefs): string | null {
  const head = r.headRef?.trim() || null;
  const base = r.baseRef?.trim() || null;
  if (!head || !base || head === base) return null;
  if (r.missionWorkingBranch && head === r.missionWorkingBranch.trim()) return head;
  if (r.refreshTrunk && r.missionWorkingBranch && base === r.missionWorkingBranch.trim()) return r.refreshTrunk.trim();
  return releaseConstituentBase(classifyReleasePr(r.releaseConfig ?? null, { ...r.pr, headRef: head, baseRef: base }));
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

const VERSION_LINE = /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/;

/**
 * The merge of the prod branch back into the source branch after a release
 * (sync-dev.yml): every parent but the first is already in the base, and what it
 * brings is only the previous release's artifacts, the CHANGELOG and package
 * versions. A `package.json` counts only when every line its patch adds or
 * removes is the `"version"` field, so a dependency change cannot ride along.
 */
export function isReleaseArtifactMerge(c: Pick<CommitFacts, 'parents' | 'diff' | 'mergeParentsInBase'>): boolean {
  if (c.parents.length < 2 || !c.mergeParentsInBase || !c.diff || c.diff.length === 0) return false;
  return c.diff.every((f) => {
    if (f.filename === 'CHANGELOG.md') return true;
    if (!(f.filename === 'package.json' || f.filename.endsWith('/package.json')) || typeof f.patch !== 'string') return false;
    const changed = f.patch.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
    return changed.length > 0 && changed.every((l) => VERSION_LINE.test(l));
  });
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
  /**
   * A commit of a PR that landed through a merge commit (not a squash): that
   * merge's sha, set only when this commit is an ancestor of the PR's merged
   * head. It is covered when that merge is proven to be the reviewed change.
   */
  landedVia?: string | null;
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
  const left = Object.fromEntries(
    Object.keys(t.ours).filter((p) => isMigrationSqlPath(p) && t.merged[p] === undefined).map((p) => [p, t.ours[p]]),
  );
  const arrived = Object.fromEntries(
    Object.keys(t.merged)
      .filter((p) => isMigrationSqlPath(p) && t.ours[p] === undefined && t.theirs[p] === undefined)
      .map((p) => [p, t.merged[p]]),
  );
  return pairMovedMigrations(left, arrived);
}

export interface ConstituentDelivery {
  deliveryId: string;
  approvedHeads: string[];
  rounds: Array<{ id: string; headSha: string; status: RoundStatus; effectiveVerdict: Verdict | null; round?: number }>;
  /** §13.13 rule 1: the constituent's own state at its head and how many of its findings are still open. */
  state?: DeliveryState | null;
  currentHeadSha?: string | null;
  openFindings?: number;
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
  /**
   * A release candidate: when the aggregate diff is past GitHub's file cap, the
   * complete commit list stands for it (the aggregate is exactly their sum), so
   * every path any commit touched counts. That can only widen what is owed a
   * review (a novel edit a later commit reverted stays listed), never narrow it.
   */
  aggregateFromCommits?: boolean;
  /** Why the collector stopped before reading everything (a full review then); set, nothing is attested. */
  abandoned?: string | null;
  verifier?: string;
  now?: string;
}

export interface CompositionResult {
  attestation: CompositionAttestation;
  constituentsEvidence: ConstituentEvidence[];
  /** Why each non-constituent commit counted as novel (for the reviewer and the activity trail). */
  novelCommits: Array<{ sha: string; reason: string; paths: string[] }>;
  /** Each novel commit's own diff, limited to its novel paths, as read (absent when unreadable). */
  novelDiffs?: Record<string, FileDiff[]>;
}

/** The decided approve round that covers `head` in a constituent's delivery. */
export function coveringRound(dl: ConstituentDelivery, head: string) {
  // §13.13 rule 1: a constituent's approve counts only while it is the LATEST decided round at its
  // head (a later request-changes at the same head supersedes it), its delivery is not blocked
  // there, and none of its findings is open. Otherwise the change is owed a review again.
  if ((dl.openFindings ?? 0) > 0) return null;
  const latestAt = (h: string) => dl.rounds.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'decided' && r.headSha === h)
    .sort((a, b) => (b.r.round ?? b.i) - (a.r.round ?? a.i))[0]?.r;
  const standing = (h: string) => latestAt(h)?.effectiveVerdict === 'approve';
  if ((dl.state === 'CHANGES_REQUESTED' || dl.state === 'ESCALATED') && dl.currentHeadSha === head) return null;
  const approves = dl.rounds.filter((r) => r.status === 'decided' && r.effectiveVerdict === 'approve' && standing(r.headSha));
  const exact = approves.find((r) => r.headSha === head);
  if (exact) return { round: exact, equivalent: [] as string[] };
  // The merged head is a recorded content-equivalent of an approved head (§8.3 carry-forward).
  if (dl.approvedHeads.includes(head)) {
    const cited = approves.filter((r) => dl.approvedHeads.includes(r.headSha)).sort((a, b) => a.headSha.localeCompare(b.headSha))[0];
    if (cited) return { round: cited, equivalent: [head] };
  }
  return null;
}

function latestDecidedVerdict(dl: ConstituentDelivery, head: string): Verdict | null {
  return dl.rounds.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'decided' && r.headSha === head)
    .sort((a, b) => (b.r.round ?? b.i) - (a.r.round ?? a.i))[0]?.r.effectiveVerdict ?? null;
}

export function buildCompositionAttestation(input: CompositionInput): CompositionResult {
  const constituents: CompositionConstituent[] = [];
  const evidence: ConstituentEvidence[] = [];
  const novel: CompositionResult['novelCommits'] = [];
  let unverifiable: string | null = input.abandoned ?? null;

  if (!input.commits) unverifiable = unverifiable ?? 'commit_list_truncated';
  // Past the file cap a candidate stands its complete commit list in for the aggregate.
  const fromCommits = !input.aggregateFiles && input.aggregateFromCommits && input.commits && input.commits.every((c) => c.files)
    ? [...new Set(input.commits.flatMap((c) => c.files!))]
    : null;
  const aggregateFiles = input.aggregateFiles ?? fromCommits;
  if (!aggregateFiles) unverifiable = unverifiable ?? 'aggregate_diff_truncated';
  const aggregate = new Set(aggregateFiles ?? []);

  // The proof that a landed change is the reviewed one, for a squash commit and
  // for a PR's merge commit alike.
  type Proof = { kind: 'constituent'; constituent: CompositionConstituent; evidence: ConstituentEvidence } | { kind: 'novel'; reason: string; paths: string[] } | { kind: 'unverifiable'; reason: string };
  const prove = (c: CommitFacts & { files: string[] }, pr: ConstituentPr): Proof => {
    const cov = pr.delivery ? coveringRound(pr.delivery, pr.mergedHeadSha) : null;
    if (!pr.delivery || !cov) {
      return { kind: 'novel', reason: pr.delivery ? `pr_${pr.prNumber}_not_approved_at_merged_head` : `pr_${pr.prNumber}_no_kernel_review`, paths: c.files };
    }
    // The proof: what this commit actually changed must be what was reviewed.
    // GitHub's commit→PR association only says which PR to compare against.
    const reviewedDiff = input.reviewedDiffs?.[c.sha] ?? null;
    if (!c.diff) return { kind: 'unverifiable', reason: `landed_patch_unreadable:${c.sha.slice(0, 12)}` };
    if (!reviewedDiff) return { kind: 'unverifiable', reason: `reviewed_patch_unreadable:${c.sha.slice(0, 12)}` };
    const landed = patchIdOf(c.diff);
    const reviewed = patchIdOf(reviewedDiff);
    if (landed.unreadable.length || reviewed.unreadable.length) {
      return { kind: 'unverifiable', reason: `patch_unreadable:${c.sha.slice(0, 12)}:${[...landed.unreadable, ...reviewed.unreadable][0]}` };
    }
    if (!landed.id || landed.id !== reviewed.id) {
      // Owed a review: the files whose landed change differs from the reviewed
      // one (a conflict resolved while merging, a hand edit in the squash). A
      // file the reviewed head changed but that never landed still means this
      // commit is not the reviewed change, so the whole commit is novel then.
      const differ = differingPaths(landed, reviewed);
      const landedDiffer = differ.filter((p) => landed.perFile.has(p));
      return { kind: 'novel', reason: `pr_${pr.prNumber}_landed_patch_differs`, paths: landedDiffer.length ? landedDiffer : c.files };
    }
    return {
      kind: 'constituent',
      constituent: {
        deliveryId: pr.delivery.deliveryId,
        roundId: cov.round.id,
        prNumber: pr.prNumber,
        reviewedHeadSha: cov.round.headSha,
        equivalentHeadShas: cov.equivalent,
        mergedHeadSha: pr.mergedHeadSha,
        landedSha: c.sha,
        landedPatchId: landed.id,
        reviewedPatchId: reviewed.id,
      },
      evidence: {
        roundId: cov.round.id,
        deliveryId: pr.delivery.deliveryId,
        prNumber: pr.prNumber,
        repoFullName: input.repoFullName,
        roundHeadSha: cov.round.headSha,
        roundStatus: cov.round.status,
        effectiveVerdict: cov.round.effectiveVerdict,
        deliveryApprovedHeads: pr.delivery.approvedHeads,
        latestDecidedVerdictAtHead: latestDecidedVerdict(pr.delivery, cov.round.headSha),
        deliveryState: pr.delivery.state ?? null,
        deliveryHeadSha: pr.delivery.currentHeadSha ?? null,
        openFindings: pr.delivery.openFindings ?? 0,
      },
    };
  };

  // A PR merged with a merge commit (not squashed): the merge, against its first
  // parent, is the PR's whole change, proven like a squash. Its own commits then
  // landed through it and are not owed anything of their own. Proven first,
  // since those commits come before their merge in the list.
  const mergeProofs = new Map<string, Proof>();
  for (const c of input.commits ?? []) {
    const pr = input.constituentsByCommit[c.sha] ?? null;
    if (c.parents.length !== 2 || !c.files || c.mergeParentsInBase || input.refresh || !pr || pr.mergedHeadSha !== c.parents[1]) continue;
    mergeProofs.set(c.sha, prove(c as CommitFacts & { files: string[] }, pr));
  }
  const accept = (p: Proof, sha: string) => {
    if (p.kind === 'unverifiable') unverifiable = unverifiable ?? p.reason;
    else if (p.kind === 'novel') { if (p.paths.length) novel.push({ sha, reason: p.reason, paths: p.paths }); }
    else { constituents.push(p.constituent); evidence.push(p.evidence); }
  };

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
      const proof = mergeProofs.get(c.sha);
      if (proof) { accept(proof, c.sha); continue; }
      // The prod branch merged back after a release brings only that release's artifacts.
      if (isReleaseArtifactMerge(c)) continue;
      // A merge commit. Bringing the base in adds nothing of its own except a
      // conflict resolution, which shows only in files both sides changed: those
      // are novel. A merge of anything not already in the base is wholly novel.
      const paths = c.mergeParentsInBase ? c.files.filter((f) => aggregate.has(f)) : c.files;
      if (paths.length) novel.push({ sha: c.sha, reason: c.mergeParentsInBase ? 'merge_resolution' : 'merge_of_unreviewed_history', paths });
      continue;
    }
    if (isReleaseArtifactCommit(c)) continue;
    if (c.landedVia && mergeProofs.get(c.landedVia)?.kind === 'constituent') continue;
    const pr = input.constituentsByCommit[c.sha] ?? null;
    if (!pr) { if (c.files.length) novel.push({ sha: c.sha, reason: 'direct_commit', paths: c.files }); continue; }
    accept(prove(c as CommitFacts & { files: string[] }, pr), c.sha);
  }

  // The aggregate must be explained by its commits: a path in the aggregate
  // diff that no commit touched means the compare is not what we read.
  if (!unverifiable && input.aggregateFiles && input.aggregateFiles.some((f) => !covered.has(f))) unverifiable = 'aggregate_not_explained_by_commits';
  if (!unverifiable && constituents.length === 0) unverifiable = 'no_reviewed_constituents';

  // Only paths still present in the aggregate diff are owed a review (a novel
  // edit later reverted by a constituent leaves nothing to look at).
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
    novelDiffs: Object.fromEntries(novel.flatMap((n) => {
      const diff = input.commits?.find((c) => c.sha === n.sha)?.diff;
      return diff ? [[n.sha, diff.filter((f) => n.paths.includes(f.filename))]] : [];
    })),
  };
}

// ── GitHub + ledger collector ───────────────────────────────────────────────

/** GitHub caps a compare at 250 commits and a diff at 300 files; at the cap the list may be cut. */
export const COMPARE_COMMIT_CAP = 250;
export const DIFF_FILE_CAP = 300;
/**
 * How long `collectComposition` may spend reading GitHub. It runs inside `dispatch_review`, and a
 * read that outlives the drain (60s) takes the reviewer with it: the effect is re-claimed and re-run
 * into the same wall. Past this, the attestation is unverifiable and the round reviews in full.
 */
export const COMPOSITION_READ_BUDGET_MS = 25_000;

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
SELECT d.id, d.pr_number, d.approved_heads, d.state, d.current_head_sha,
  (SELECT count(*) FROM workflow_findings f WHERE f.delivery_id = d.id AND f.required AND f.status IN ('open', 'addressed')) AS open_findings,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'round', r.round, 'head_sha', r.head_sha, 'status', r.status, 'effective_verdict', r.effective_verdict))
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
  /**
   * The branch the constituent PRs merged into, from `compositionConstituentBase`.
   * Absent = the head branch (a mission integration or legacy release PR).
   * A release candidate passes its source branch: its commits landed on dev
   * through PRs into dev, and the candidate branch itself never had a PR.
   */
  constituentBase?: string | null;
  /** A release candidate: past the file cap, the complete commit list stands in for the aggregate (see `CompositionInput`). */
  aggregateFromCommits?: boolean;
  /** Overrides `COMPOSITION_READ_BUDGET_MS`, and the clock it is measured on (tests). */
  budgetMs?: number;
  clock?: () => number;
}): Promise<CompositionResult> {
  const { api, installationId: inst, repoFullName: repo } = p;
  const clock = p.clock ?? Date.now;
  const deadline = clock() + (p.budgetMs ?? COMPOSITION_READ_BUDGET_MS);
  const spent = () => clock() > deadline;
  const cmp = (await api(inst, `/repos/${repo}/compare/${encodeURIComponent(p.baseRef)}...${p.aggregateHeadSha}?per_page=${COMPARE_COMMIT_CAP}`)) as GhCompare | null;
  const baseSha = cmp?.merge_base_commit?.sha ?? '';
  const baseHead = cmp?.base_commit?.sha ?? baseSha;
  const rawCommits = cmp?.commits ?? [];
  const truncatedCommits = !cmp || (cmp.total_commits ?? rawCommits.length) > rawCommits.length || rawCommits.length >= COMPARE_COMMIT_CAP;
  const aggregateFiles = cmp?.files && cmp.files.length < DIFF_FILE_CAP ? cmp.files.map((f) => f.filename) : null;

  const refreshTrunk = p.refreshTrunk?.trim() || null;
  const unproven = (abandoned: string | null) => buildCompositionAttestation({
    repoFullName: repo, prNumber: p.prNumber, baseSha, aggregateHeadSha: p.aggregateHeadSha,
    commits: null, aggregateFiles, constituentsByCommit: {}, refresh: refreshTrunk ? { trunk: refreshTrunk } : null, abandoned,
  });
  // The compare alone already says nothing can be proven: read no commit (26b969db).
  if (truncatedCommits) return unproven(null);
  if (!aggregateFiles && !p.aggregateFromCommits) return unproven('aggregate_diff_truncated');
  const BUDGET_SPENT = 'composition_read_budget_spent';
  // A refresh's constituents landed on trunk; a candidate's on its source
  // branch; anything else's on its head branch.
  const constituentBase = refreshTrunk ?? (p.constituentBase?.trim() || p.headRef);
  const commits: CommitFacts[] = [];
  const prsByCommit: Record<string, { prNumber: number; mergedHeadSha: string } | null> = {};
  const mergedPrOf = async (sha: string) => {
    try {
      const pulls = (await api(inst, `/repos/${repo}/commits/${sha}/pulls`)) as Array<{ number: number; merged_at?: string | null; base?: { ref?: string }; head?: { sha?: string } }> | null;
      const hit = (pulls ?? []).find((x) => x.merged_at && x.base?.ref === constituentBase && x.head?.sha);
      return hit ? { prNumber: hit.number, mergedHeadSha: hit.head!.sha! } : null;
    } catch { return null; }
  };
  for (const c of rawCommits) {
    if (spent()) return unproven(BUDGET_SPENT);
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
      // A PR landed with a merge commit: the merge is associated with it, and its second parent is the PR's head.
      if (!refreshTrunk && !mergeParentsInBase && parents.length === 2) {
        const pr = await mergedPrOf(c.sha);
        if (pr && pr.mergedHeadSha === parents[1]) prsByCommit[c.sha] = pr;
      }
    } else {
      prsByCommit[c.sha] = await mergedPrOf(c.sha);
    }
    commits.push({ sha: c.sha, parents, message: c.commit?.message ?? '', files, diff, mergeParentsInBase });
  }

  // That PR's own commits landed through its merge, but only those the PR's head
  // actually contains: GitHub's association alone never excuses a commit.
  for (const m of commits) {
    const pr = m.parents.length === 2 ? prsByCommit[m.sha] : null;
    if (!pr) continue;
    for (const c of commits) {
      if (c.parents.length !== 1 || prsByCommit[c.sha]?.prNumber !== pr.prNumber) continue;
      if (spent()) return unproven(BUDGET_SPENT);
      if (await onRef(api, inst, repo, c.sha, m.parents[1])) c.landedVia = m.sha;
    }
  }

  const prNumbers = [...new Set(Object.values(prsByCommit).filter(Boolean).map((x) => x!.prNumber))];
  const deliveries = new Map<number, ConstituentDelivery>();
  if (prNumbers.length) {
    const rows = ((await p.exec(deliveryRoundsSql(p.workspaceId, repo, prNumbers))).rows ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      deliveries.set(Number(r.pr_number), {
        deliveryId: String(r.id),
        approvedHeads: (r.approved_heads as string[] | null) ?? [],
        state: (r.state ?? null) as DeliveryState | null,
        currentHeadSha: (r.current_head_sha ?? null) as string | null,
        openFindings: Number(r.open_findings ?? 0),
        rounds: ((r.rounds as Array<Record<string, unknown>>) ?? []).map((x) => ({
          id: String(x.id), round: x.round == null ? undefined : Number(x.round), headSha: String(x.head_sha), status: x.status as RoundStatus, effectiveVerdict: (x.effective_verdict ?? null) as Verdict | null,
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
    // A squash against its parent; a PR's merge commit against its first parent (the PR's own commits need none).
    if (!cov || c.landedVia || (c.parents.length !== 1 && !(c.parents.length === 2 && pr!.mergedHeadSha === c.parents[1]))) continue;
    if (spent()) return unproven(BUDGET_SPENT);
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
    aggregateFromCommits: p.aggregateFromCommits ?? false,
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
