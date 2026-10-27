/**
 * Automatic supersession detection for closed-unmerged PRs.
 *
 * A PR that closes without merging blocks its mission (`closed_unsuperseded`,
 * pr-shipped.ts) until someone records where the work went. Often it went
 * somewhere obvious — a sibling task in the same mission merged it, a human
 * closed it "in favour of #N", the files moved to another repo — and the owner
 * had to work that out by hand and call record_pr_supersession.
 *
 * This module does the legwork, under one hard rule: NOTHING durable is
 * recorded from a claim. Close comments, PR bodies, cross-references, sibling
 * tasks and file overlap only nominate candidates. A candidate becomes an edge
 * only when the closed PR's changes are found in the candidate's own merged
 * diff (lib/pr-supersession-verify.ts — patch-id or content). #2556 and #2563
 * were closed as "superseded by #N" where #N carried none of their work; that
 * claim would be a suggestion here, never an edge.
 *
 *   verified        → recordPrSupersession (the same path record_pr_supersession
 *                     takes), reason "auto: content verified in #N (method: …)",
 *                     plus an `accepted` gate event carrying method + confidence.
 *   candidates only → `workers.supersessionScan.suggestion` for the mission card
 *                     to offer as "Likely superseded by #N" with Confirm, plus a
 *                     `deferred` gate event. No edge.
 *   nothing         → the scan is stamped so the sweep does not re-ask hourly.
 *
 * Four doors: the pull_request.closed webhook (merged=false) for a legacy PR;
 * the workflow kernel's `scan_supersession` effect for a PR it owns (T18), so
 * the scan is owed durably rather than run in a request; and the hourly
 * pr-reconcile backfill (`sweepClosedUnsupersededPrs`) for webhook misses and
 * PRs that closed before this existed; and a merge (`rescanOnMerge`), which
 * looks again at the closed PRs the merged one may carry, because a scan at
 * close time cannot see a re-land that did not exist yet. Whichever door finds the proof, the
 * edge is written by `recordPrSupersession`, which hands a kernel-owned PR to
 * T20 (docs/specs/workflow-state-kernel.md §13.8).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { prShipState, type RefreshCheck, type SupersessionScan, type SupersessionSignal, type SupersessionSuggestion } from '@buildd/core/pr-shipped';
import { MISSION_BRANCH_PREFIX } from '@buildd/core/mission-integration';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { recordPrSupersession, supersessionRepoScope } from '@/lib/pr-supersession';
import { deferralOf, isOutageAnswer, nextDeferral } from '@/lib/control-plane-deferral';
import { verifyByContent, verifyByPatchId, mapPath, parseSupersessionClaims, significantAddedLines, type DiffFile } from '@/lib/pr-supersession-verify';
import { integrationRefreshOf, refreshFiledFor, type IntegrationRefreshContext } from '@/lib/integration-refresh';
import { verifyRefreshInBranch } from '@/lib/pr-supersession-refresh';
import { normalizeRepoFullName, prUrlFor, repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { createTeamInstallationResolver } from '@/lib/workspace-installation';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * `kernel`: the workflow kernel's `scan_supersession` effect for a PR it owns (T18).
 * `merge`: a candidate merged, so a closed PR it may carry is looked at again (`rescanOnMerge`).
 */
export type DetectVia = 'webhook' | 'sweep' | 'kernel' | 'merge';

export type SupersessionMethod = 'patch-id' | 'content';

export type DetectResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'recorded'; repo: string; prNumber: number; method: SupersessionMethod; confidence: number }
  | { outcome: 'suggested'; suggestion: SupersessionSuggestion; candidatesChecked: number }
  | { outcome: 'none'; candidatesChecked: number }
  /**
   * A candidate verified, but the control plane did not answer the record (a retryable outage, the
   * pass's budget spent). Not stamped, no suggestion: the content DID verify, so the next sweep
   * tries again, up to the deferral cap. A refusal or a failed command is not deferred.
   */
  | { outcome: 'deferred'; reason: string; candidatesChecked: number };

/**
 * Time limits for one detection run. Both are opt-in: the webhook and kernel doors pass none and
 * behave as before. The hourly sweep passes both (`SWEEP_LIMITS`).
 *
 * A run cut short by either writes no verdict: not stamped, no suggestion, no "none". It defers to
 * the next tick, keeping the candidates it did judge (`SupersessionScan.judged`) and recording the
 * attempt (`lastAttemptAt`), which moves the row behind the others in the sweep's queue. A request
 * timeout counts toward the control-plane deferral cap (lib/control-plane-deferral.ts). A budget stop
 * counts only for the first row of a sweep: that row had the whole budget to itself, so the stop is
 * its own cost; a later row was cut off by the rows before it.
 */
export interface DetectLimits {
  /** Each GitHub call is abandoned after this long. */
  requestTimeoutMs?: number;
  /** The pass's own clock: when it fires, every call in flight is abandoned and no new one starts. */
  budget?: AbortSignal;
  /** This is the first row the sweep started, so it had the whole budget. */
  first?: boolean;
}

/** The hourly sweep's limits. The route's function limit is 60 s, shared with a dozen other steps. */
export const SWEEP_LIMITS = {
  /** Wall time for the whole sweep. */
  budgetMs: 20_000,
  /** One GitHub call. They normally answer in well under a second. */
  requestTimeoutMs: 5_000,
} as const;

type Interruption = 'timeout' | 'budget';

/**
 * GitHub reads for one detection run, cut off by `DetectLimits`. Most reads below swallow their
 * errors into an empty answer (a missing PR is not a failure), so an abandoned read would look like
 * "nothing there". `interrupted` is how the run knows it must not judge on what it has.
 *
 * The first interruption sticks: once one call is abandoned, no new call starts, and every call
 * still in flight (the other side of a parallel read) is aborted with it. `close()` aborts whatever
 * is left when the run returns, so nothing reads GitHub after the run is over.
 */
class GhReader {
  interrupted: Interruption | null = null;
  private readonly run = new AbortController();
  constructor(private readonly limits: DetectLimits = {}) {}

  private interrupt(why: Interruption) {
    this.interrupted ??= why;
    this.run.abort();
  }

  /** True once the run was cut short, by a timeout or the pass's budget. */
  stopped(): boolean {
    if (!this.interrupted && this.limits.budget?.aborted) this.interrupt('budget');
    return this.interrupted != null;
  }

  /** The run is over: abandon anything still reading. */
  close() {
    this.run.abort();
  }

  async call(inst: number, path: string) {
    if (this.stopped()) throw new Error(`supersession scan stopped (${this.interrupted}) before ${path}`);
    if (this.run.signal.aborted) throw new Error(`supersession scan is over before ${path}`);
    const signals: AbortSignal[] = [this.run.signal];
    if (this.limits.requestTimeoutMs != null) signals.push(AbortSignal.timeout(this.limits.requestTimeoutMs));
    if (this.limits.budget) signals.push(this.limits.budget);
    const signal = AbortSignal.any(signals);
    try {
      return await githubApi(inst, path, { signal });
    } catch (err) {
      // Aborted by this run itself (another call's interruption, or close): already labelled.
      if (signal.aborted && !this.run.signal.aborted) this.interrupt(this.limits.budget?.aborted ? 'budget' : 'timeout');
      throw err;
    }
  }
}

/**
 * A candidate's verdict, kept on the scan so a later run inside the rescan window does not pay
 * for it again. Only merged candidates are kept: a merged PR's diff no longer changes, while an
 * unmerged one may still merge.
 */
interface JudgedPair {
  repo: string;
  prNumber: number;
  prUrl: string;
  verified: boolean;
  method?: SupersessionMethod;
  confidence: number;
  /** ISO time it was judged. */
  at: string;
  /** The closed PR's head when it was judged: a push since (reopen, push, close) invalidates it. */
  closedHeadSha?: string;
  /** The candidate's merge commit when it was judged. */
  mergeCommitSha?: string;
}

/** At most this many judged pairs are kept on a scan. */
const JUDGED_KEEP = 20;

/** Actor label on an auto-recorded edge — distinguishes it from a person's. */
export const AUTO_SUPERSESSION_ACTOR = 'system:auto-supersession';

/** Bounds, so one webhook or sweep step stays inside a serverless budget. */
export const DETECT_LIMITS = {
  /** Candidates content-checked per PR. */
  maxVerify: 6,
  /** Recent merged PRs considered for file overlap. */
  overlapScan: 30,
  /** Of those, how many get their file list fetched. */
  overlapFetch: 10,
  /** Above this many commits on either side, patch-id is not attempted. */
  maxPatchIdCommits: 10,
  /** Candidate files whose contents are fetched when GitHub omitted the patch. */
  maxContentFetch: 3,
} as const;

const SIGNAL_SCORE: Record<SupersessionSignal, number> = {
  claim: 0.9,
  cross_reference: 0.7,
  sibling_task: 0.6,
  file_overlap: 0.3,
};

interface Candidate {
  repo: string;
  prNumber: number;
  signal: SupersessionSignal;
  why: string;
  score: number;
}

interface GhPr {
  number: number;
  body?: string | null;
  created_at?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  html_url?: string;
  commits?: number;
  title?: string;
  head?: { sha?: string };
}

const SURFACE: Record<DetectVia, string> = {
  webhook: 'webhook pull_request.closed',
  sweep: 'cron pr-reconcile',
  kernel: 'workflow scan_supersession',
  merge: 'webhook pull_request.closed (merged)',
};

const key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

/**
 * Installation per repo, cached for one detection run: only the workspace's own team's
 * installation, so a candidate in a repo another team's installation covers is never read.
 */
function installationResolver(workspaceId: string | null) {
  const { forWorkspace } = createTeamInstallationResolver();
  return async (repo: string): Promise<number | null> => (await forWorkspace(repo, workspaceId)).installationId;
}

async function listFiles(gh: GhReader, inst: number, repo: string, n: number): Promise<DiffFile[]> {
  const files = await gh.call(inst, `/repos/${repo}/pulls/${n}/files?per_page=100`);
  return Array.isArray(files) ? files : [];
}

async function commitDiffs(gh: GhReader, inst: number, repo: string, n: number): Promise<DiffFile[][]> {
  const commits = await gh.call(inst, `/repos/${repo}/pulls/${n}/commits?per_page=${DETECT_LIMITS.maxPatchIdCommits}`);
  const out: DiffFile[][] = [];
  for (const c of Array.isArray(commits) ? commits : []) {
    // A merge commit (two parents) carries no change of its own.
    if (Array.isArray(c?.parents) && c.parents.length > 1) continue;
    const full = await gh.call(inst, `/repos/${repo}/commits/${c.sha}`);
    out.push(Array.isArray(full?.files) ? full.files : []);
  }
  return out;
}

async function fileContent(gh: GhReader, inst: number, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await gh.call(inst, `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (typeof res?.content !== 'string') return null;
    return Buffer.from(res.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Verdict on one candidate. `merged: false` drops it from suggestions too. */
interface CandidateVerdict {
  merged: boolean;
  verified: boolean;
  method?: SupersessionMethod;
  confidence: number;
  prUrl?: string;
  mergeCommitSha?: string;
  /**
   * Merged, but its file list could not be read: its content was never compared. Unavailable
   * proof, not negative proof — never cached, never kept as a judged pair, never a ratio of 0.
   */
  unavailable?: true;
}

async function verifyCandidate(opts: {
  gh: GhReader;
  closedRepo: string;
  closed: GhPr;
  closedFiles: DiffFile[];
  closedInst: number;
  cand: Candidate;
  inst: number;
  filesCache: Map<string, DiffFile[]>;
  /** A verdict an earlier run reached on this pair; reused only if neither side has moved since. */
  prior?: JudgedPair;
}): Promise<CandidateVerdict> {
  const { cand, inst, gh, prior } = opts;
  const pr: GhPr | null = await gh.call(inst, `/repos/${cand.repo}/pulls/${cand.prNumber}`).catch(() => null);
  if (!pr?.merged) return { merged: false, verified: false, confidence: 0 };
  const prUrl = pr.html_url ?? prUrlFor(cand.repo, cand.prNumber);
  const closedHead = opts.closed.head?.sha;
  if (prior && closedHead && prior.closedHeadSha === closedHead && pr.merge_commit_sha && prior.mergeCommitSha === pr.merge_commit_sha) {
    return { merged: true, verified: prior.verified, method: prior.method, confidence: prior.confidence, prUrl, mergeCommitSha: pr.merge_commit_sha };
  }

  const k = key(cand.repo, cand.prNumber);
  let candFiles = opts.filesCache.get(k);
  if (!candFiles) {
    try {
      candFiles = await listFiles(gh, inst, cand.repo, cand.prNumber);
    } catch (err) {
      console.warn(`[pr-supersession-detect] could not read the files of ${k}:`, err);
      return { merged: true, verified: false, confidence: 0, unavailable: true, prUrl, mergeCommitSha: pr.merge_commit_sha ?? undefined };
    }
    opts.filesCache.set(k, candFiles);
  }

  // Large new files come back without a patch; read them at the merge commit.
  const contents = new Map<string, string>();
  if (pr.merge_commit_sha) {
    const wanted = opts.closedFiles
      .filter(f => f.status !== 'removed' && significantAddedLines(f.patch).length > 0)
      .map(f => mapPath(f.filename, candFiles!))
      .filter((t): t is DiffFile => !!t && t.patch == null && t.status === 'added')
      .slice(0, DETECT_LIMITS.maxContentFetch);
    for (const t of wanted) {
      const c = await fileContent(gh, inst, cand.repo, t.filename, pr.merge_commit_sha);
      if (c != null) contents.set(t.filename, c);
    }
  }

  const content = verifyByContent(opts.closedFiles, candFiles, contents);
  const mergeCommitSha = pr.merge_commit_sha ?? undefined;
  if (content.verified) return { merged: true, verified: true, method: 'content', confidence: content.ratio, prUrl, mergeCommitSha };

  const small = (n: number | undefined) => typeof n === 'number' && n > 0 && n <= DETECT_LIMITS.maxPatchIdCommits;
  if (small(opts.closed.commits) && small(pr.commits)) {
    try {
      const [a, b] = await Promise.all([
        commitDiffs(gh, opts.closedInst, opts.closedRepo, opts.closed.number),
        commitDiffs(gh, inst, cand.repo, cand.prNumber),
      ]);
      const pid = verifyByPatchId(a, b);
      if (pid.verified) return { merged: true, verified: true, method: 'patch-id', confidence: 1, prUrl, mergeCommitSha };
    } catch (err) {
      console.warn(`[pr-supersession-detect] patch-id read failed for ${k}:`, err);
    }
  }
  return { merged: true, verified: false, confidence: content.ratio, prUrl, mergeCommitSha };
}

/**
 * Whether one merged PR carries another PR's changes.
 *
 *  - `verified`: the candidate's own merged diff holds the PR's added lines (content), or every
 *    commit has a patch-id twin in it. `method` and `confidence` are what the edge's reason names.
 *  - `unverified`: both sides were read, and the candidate does not carry the PR.
 *  - `unavailable`: no verdict. The PR or the candidate could not be read, the candidate is not
 *    merged, the PR has no diff to compare, or a read was cut short. A caller must not act on it.
 */
export type CarriedVerdict =
  | { outcome: 'verified'; method: SupersessionMethod; confidence: number }
  | { outcome: 'unverified'; confidence: number }
  | { outcome: 'unavailable'; reason: string };

/**
 * The same proof `detectPrSupersession` demands before it records an edge, for a caller that is
 * about to ACT on a supersession it has only inferred. Dead-PR shutdown (lib/dead-pr-shutdown.ts)
 * nominates a "loser" from a shared subject anchor, a shared mission, a shared base and idle time;
 * none of that says the merged "winner" carries the loser's change (#5461 was closed as superseded
 * by a sibling task's PR that shared none of its work). This reads GitHub only and records nothing:
 * the caller closes and records the edge in its own flow, or leaves the PR alone.
 *
 * Content is checked first (it catches a squash), then patch-id when both sides are small. A
 * candidate file list GitHub would not give is `unavailable`, not an empty diff that would read
 * as "carries nothing".
 */
export async function verifyPrCarriedBy(opts: {
  installationId: number;
  repo: string;
  /** The PR whose changes must be found. Open or closed; its diff is what is compared. */
  prNumber: number;
  /** The merged PR that may carry them. */
  candidatePrNumber: number;
  /** Opt-in time limits; absent, GitHub calls wait as long as they take. */
  limits?: DetectLimits;
}): Promise<CarriedVerdict> {
  const { installationId: inst, repo } = opts;
  const gh = new GhReader(opts.limits);
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    let pr: GhPr;
    let files: DiffFile[];
    try {
      pr = await gh.call(inst, `/repos/${repo}/pulls/${opts.prNumber}`);
      files = await listFiles(gh, inst, repo, opts.prNumber);
    } catch (err) {
      return { outcome: 'unavailable', reason: `could not read ${repo}#${opts.prNumber}: ${why(err)}` };
    }
    if (!pr || typeof pr.number !== 'number') return { outcome: 'unavailable', reason: `${repo}#${opts.prNumber} did not read as a pull request` };
    if (files.length === 0) return { outcome: 'unavailable', reason: `${repo}#${opts.prNumber} has no files to compare` };

    // The candidate's files are read here first, so the reason names the read that failed.
    const filesCache = new Map<string, DiffFile[]>();
    try {
      filesCache.set(key(repo, opts.candidatePrNumber), await listFiles(gh, inst, repo, opts.candidatePrNumber));
    } catch (err) {
      return { outcome: 'unavailable', reason: `could not read the files of ${repo}#${opts.candidatePrNumber}: ${why(err)}` };
    }

    const cand: Candidate = { repo, prNumber: opts.candidatePrNumber, signal: 'sibling_task', score: SIGNAL_SCORE.sibling_task, why: 'nominated by the caller' };
    const v = await verifyCandidate({ gh, closedRepo: repo, closed: pr, closedFiles: files, closedInst: inst, cand, inst, filesCache });
    if (gh.interrupted) return { outcome: 'unavailable', reason: `a GitHub read was cut short (${gh.interrupted})` };
    if (!v.merged) return { outcome: 'unavailable', reason: `${repo}#${opts.candidatePrNumber} is not merged, or could not be read` };
    if (v.unavailable) return { outcome: 'unavailable', reason: `could not read the files of ${repo}#${opts.candidatePrNumber}` };
    if (v.verified) return { outcome: 'verified', method: v.method!, confidence: v.confidence };
    return { outcome: 'unverified', confidence: v.confidence };
  } catch (err) {
    return { outcome: 'unavailable', reason: `verification failed: ${why(err)}` };
  } finally {
    gh.close();
  }
}

/**
 * Look for where a closed-unmerged PR's work landed, and record it only if the
 * content proves it. Never throws for GitHub trouble — a failed read is a
 * `skipped` result and the sweep tries again later.
 */
export async function detectPrSupersession(opts: {
  workerId: string;
  via: DetectVia;
  now?: Date;
  /** The kernel's delivery for the PR, when it owns it: its state, not the (possibly lagging) columns, says whether the PR is closed. */
  delivery?: { state: string } | null;
  /** Opt-in time limits (the sweep's); absent, GitHub calls wait as long as they take. */
  limits?: DetectLimits;
  /**
   * A merged PR the caller already knows may carry this one (`rescanOnMerge`): judged with the
   * candidates this PR's own signals find, by the same content check. Naming it proves nothing.
   */
  nominee?: { repo: string; prNumber: number; signal: SupersessionSignal; why: string };
}): Promise<DetectResult> {
  const gh = new GhReader(opts.limits);
  try {
    return await detectOnce(opts, gh);
  } finally {
    // Nothing this run started may keep reading GitHub after it returns.
    gh.close();
  }
}

async function detectOnce(opts: Parameters<typeof detectPrSupersession>[0], gh: GhReader): Promise<DetectResult> {
  const now = opts.now ?? new Date();
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, opts.workerId)),
    columns: {
      id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true, mergedAt: true,
      prLifecycleStatus: true, supersededByPrNumber: true, abandonedAt: true, supersessionScan: true,
    },
    with: {
      task: { columns: { id: true, missionId: true, context: true } },
      workspace: { columns: { repo: true }, with: { githubRepo: { columns: { fullName: true } } } },
    },
  });
  if (!worker) return { outcome: 'skipped', reason: 'worker not found' };
  // Already merged, superseded, abandoned or still open: nothing to find.
  if (prShipState({ ...worker, delivery: opts.delivery ?? null }) !== 'closed_unsuperseded') return { outcome: 'skipped', reason: 'not closed-unsuperseded' };

  const scanRows = or(eq(workers.id, worker.id), and(eq(workers.prUrl, worker.prUrl!), isNull(workers.mergedAt)));
  const closedRepo = repoFullNameFromPrUrl(worker.prUrl);
  const prNumber = worker.prNumber;
  if (!closedRepo || !prNumber) return { outcome: 'skipped', reason: 'no parsable PR url' };

  const installationFor = installationResolver(worker.workspaceId);
  const closedInst = await installationFor(closedRepo);
  if (!closedInst) return { outcome: 'skipped', reason: `no installation for ${closedRepo}` };

  // An integration-refresh PR's work is ancestry plus what it adds on top of trunk (mission
  // migrations, schema, conflict resolution), not a change a sibling PR could "carry": its
  // effective diff is near-empty by construction, so a content check against any candidate finds
  // nothing, and the fallback below used to offer that as "likely superseded" (task c8092d2a /
  // PR #5530, nominated by sibling-task against an unrelated merged PR on zero shared lines).
  // It gets the refresh proof instead (`checkClosedRefresh`), never a generic candidate.
  const refresh = integrationRefreshOf(worker.task?.context);
  if (refresh) {
    return checkClosedRefresh({
      gh, opts, now, worker, refresh, context: worker.task?.context, closedRepo, prNumber, inst: closedInst, scanRows,
    });
  }

  let closed: GhPr;
  let closedFiles: DiffFile[];
  try {
    closed = await gh.call(closedInst, `/repos/${closedRepo}/pulls/${prNumber}`);
    if (closed?.merged) return { outcome: 'skipped', reason: 'PR is merged on GitHub' };
    closedFiles = await listFiles(gh, closedInst, closedRepo, prNumber);
  } catch (err) {
    console.warn(`[pr-supersession-detect] could not read ${closedRepo}#${prNumber}:`, err);
    // Not a verdict on the PR: the sweep would stamp a "skipped" row, so a timeout defers instead.
    if (!gh.interrupted) return { outcome: 'skipped', reason: 'could not read the closed PR' };
    closed = { number: prNumber };
    closedFiles = [];
  }

  const prevScan: SupersessionScan | null = worker.supersessionScan ?? null;
  // Verdicts this PR's earlier runs reached inside the rescan window, and the ones this run adds.
  const judgedSince = now.getTime() - RESCAN_AFTER_MS;
  const judged = new Map<string, JudgedPair>();
  for (const j of prevScan?.judged ?? []) {
    if (j && typeof j.prNumber === 'number' && typeof j.repo === 'string' && Date.parse(j.at) > judgedSince) judged.set(key(j.repo, j.prNumber), j);
  }
  const judgedList = () => [...judged.values()].slice(-JUDGED_KEEP);
  // A row that never finished a scan carries no finished-scan time while it is deferred, so it still
  // reads as reconciling (delivery-projection.ts) rather than "scanned, nothing found".
  const unfinished = (): SupersessionScan => prevScan ?? { scannedAt: '', candidatesChecked: checked, suggestion: null };
  const attempt = () => ({ judged: judgedList(), lastAttemptAt: now.toISOString() });
  let checked = 0;

  // A run GitHub or the pass's clock cut short: no verdict is written (no stamp, no suggestion).
  // What it did judge is kept. A request timeout counts toward the deferral cap, the way a
  // control-plane outage does; past the cap the row is settled so it cannot hold the queue forever.
  const deferInterrupted = async (): Promise<DetectResult> => {
    const base = unfinished();
    if (gh.interrupted === 'budget' && !opts.limits?.first) {
      // Cut off by the rows before it: not counted, but the attempt moves it behind them next tick.
      await db.update(workers).set({ supersessionScan: { ...base, ...attempt() } }).where(scanRows);
      return { outcome: 'deferred', reason: 'the supersession sweep ran out of time', candidatesChecked: checked };
    }
    const reason = gh.interrupted === 'budget'
      ? 'this scan alone used the sweep\'s whole time budget'
      : `a GitHub request did not answer within ${opts.limits?.requestTimeoutMs}ms`;
    const { state, exhausted } = nextDeferral(deferralOf(prevScan?.deferral), reason, now);
    if (!exhausted) {
      await db.update(workers).set({ supersessionScan: { ...base, deferral: state, ...attempt() } }).where(scanRows);
      return { outcome: 'deferred', reason, candidatesChecked: checked };
    }
    const { deferral: _done, ...rest } = base;
    await db.update(workers)
      .set({ supersessionScan: { ...rest, scannedAt: now.toISOString(), candidatesChecked: checked, suggestion: prevScan?.suggestion ?? null, deferralExhausted: state, ...attempt() }, supersessionScannedAt: now })
      .where(scanRows);
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
      surface: SURFACE[opts.via],
      outcome: 'stranded',
      reason: `supersession scan never finished: cut short (${state.reason}) for ${state.count} sweep(s); settled without a verdict`,
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id,
      detail: { kind: 'github_timeout_deferral_exhausted', prNumber, repo: closedRepo, deferral: state },
      callerOrigin: 'system',
    });
    return { outcome: 'skipped', reason: `cut short for ${state.count} sweep(s); settled without a verdict` };
  };
  if (gh.interrupted) return deferInterrupted();
  const dismissed = new Set((prevScan?.dismissed ?? []).map(u => u.toLowerCase()));
  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (sameKey(c, closedRepo, prNumber)) return;
    if (dismissed.has(prUrlFor(c.repo, c.prNumber).toLowerCase())) return;
    const prev = candidates.get(key(c.repo, c.prNumber));
    if (!prev || prev.score < c.score) candidates.set(key(c.repo, c.prNumber), c);
  };

  if (opts.nominee) add({ ...opts.nominee, score: SIGNAL_SCORE[opts.nominee.signal] });

  // (a) Claims: the PR body and its comments, then GitHub's cross-references.
  for (const c of parseSupersessionClaims(closed.body, closedRepo)) {
    add({ ...c, signal: 'claim', score: SIGNAL_SCORE.claim, why: `this PR's description names ${refOf(c, closedRepo)} as its replacement` });
  }
  const comments = await gh.call(closedInst, `/repos/${closedRepo}/issues/${prNumber}/comments?per_page=50`).catch(() => []);
  for (const cm of Array.isArray(comments) ? comments : []) {
    for (const c of parseSupersessionClaims(cm?.body, closedRepo)) {
      add({ ...c, signal: 'claim', score: SIGNAL_SCORE.claim, why: `a comment on this PR says it was superseded by ${refOf(c, closedRepo)}` });
    }
  }
  const timeline = await gh.call(closedInst, `/repos/${closedRepo}/issues/${prNumber}/timeline?per_page=100`).catch(() => []);
  for (const ev of Array.isArray(timeline) ? timeline : []) {
    const issue = ev?.event === 'cross-referenced' ? ev?.source?.issue : null;
    if (!issue?.pull_request || typeof issue.number !== 'number') continue;
    const repo = normalizeRepoFullName(issue.repository?.full_name) ?? closedRepo;
    add({ repo, prNumber: issue.number, signal: 'cross_reference', score: SIGNAL_SCORE.cross_reference, why: `${refOf({ repo, prNumber: issue.number }, closedRepo)} references this PR` });
  }
  // An abandoned comments or timeline read would silently drop the claims it carries.
  if (gh.interrupted) return deferInterrupted();

  // (b) Merged PRs from sibling tasks in the same mission, any repo.
  const missionId = worker.task?.missionId ?? null;
  if (missionId) {
    const siblings = await db.query.tasks.findMany({
      where: sqlWhere(eq(tasks.missionId, missionId)),
      columns: { id: true, title: true },
      with: { workers: { columns: { prUrl: true, prNumber: true, mergedAt: true } } },
    });
    for (const t of siblings) {
      if (t.id === worker.taskId) continue;
      for (const w of t.workers ?? []) {
        const repo = repoFullNameFromPrUrl(w.prUrl);
        if (!w.mergedAt || !repo || !w.prNumber) continue;
        add({ repo, prNumber: w.prNumber, signal: 'sibling_task', score: SIGNAL_SCORE.sibling_task, why: `merged by "${t.title}" in the same mission` });
      }
    }
  }

  const filesCache = new Map<string, DiffFile[]>();
  const merged: Array<Candidate & { prUrl: string; confidence: number; unavailable?: true }> = [];

  // A verified candidate the control plane did not take: deferred to the next sweep (nothing stamped),
  // until the deferral runs out; then it is filed as a suggestion with why, and a stranded gate event.
  // `confidence` comes from the content/patch-id check that already verified this candidate
  // (the only way a caller reaches this function) — never 0 here, unlike the zero-evidence
  // fallback suggestion below.
  const deferOrExhaust = async (cand: Candidate, candUrl: string, reason: string, confidence: number): Promise<DetectResult> => {
    const { state, exhausted } = nextDeferral(deferralOf(prevScan?.deferral), reason, now);
    const base = unfinished();
    if (!exhausted) {
      await db.update(workers).set({ supersessionScan: { ...base, deferral: state, ...attempt() } }).where(scanRows);
      return { outcome: 'deferred', reason, candidatesChecked: checked };
    }
    const suggestion: SupersessionSuggestion = {
      repo: cand.repo, prNumber: cand.prNumber, prUrl: candUrl, signal: cand.signal,
      why: `${cand.why}; its content verified, but the control plane did not take the record for ${state.count} sweep(s) since ${state.firstAt} (${reason})`,
      score: Math.round(cand.score * 100) / 100,
      contentRatio: Math.round(confidence * 100) / 100,
    };
    const { deferral: _done, ...rest } = base;
    await db.update(workers)
      .set({ supersessionScan: { ...rest, scannedAt: now.toISOString(), candidatesChecked: checked, suggestion, deferralExhausted: state, ...attempt() }, supersessionScannedAt: now })
      .where(scanRows);
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
      surface: SURFACE[opts.via],
      outcome: 'stranded',
      reason: `supersession content verified but never recorded: the control plane did not answer for ${state.count} sweep(s); suggested for a person instead`,
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id,
      detail: { kind: 'control_plane_deferral_exhausted', prNumber, repo: closedRepo, candidate: { repo: cand.repo, prNumber: cand.prNumber }, deferral: state },
      callerOrigin: 'system',
    });
    return { outcome: 'suggested', suggestion, candidatesChecked: checked };
  };

  const tryAll = async (list: Candidate[]): Promise<DetectResult | null> => {
    for (const cand of list) {
      if (checked >= DETECT_LIMITS.maxVerify) break;
      if (gh.stopped()) return null;
      const inst = await installationFor(cand.repo);
      if (!inst) continue;
      checked++;
      const k = key(cand.repo, cand.prNumber);
      const prior = judged.get(k);
      const v = await verifyCandidate({ gh, closedRepo, closed, closedFiles, closedInst, cand, inst, filesCache, prior })
        .catch(err => {
          console.warn(`[pr-supersession-detect] verify failed for ${k}:`, err);
          return { merged: false, verified: false, confidence: 0 } as CandidateVerdict;
        });
      // An abandoned read makes a candidate look unmerged or empty: never judge on it.
      if (gh.interrupted) return null;
      if (v.merged && !v.unavailable) {
        const reused = prior && prior.mergeCommitSha === v.mergeCommitSha && prior.closedHeadSha === closed.head?.sha;
        if (!reused) {
          judged.set(k, {
            repo: cand.repo, prNumber: cand.prNumber, prUrl: v.prUrl!, verified: v.verified, ...(v.method ? { method: v.method } : {}),
            confidence: v.confidence, at: now.toISOString(),
            ...(closed.head?.sha ? { closedHeadSha: closed.head.sha } : {}), ...(v.mergeCommitSha ? { mergeCommitSha: v.mergeCommitSha } : {}),
          });
        }
      } else {
        judged.delete(k);
      }
      if (!v.merged) continue;
      merged.push({ ...cand, prUrl: v.prUrl!, confidence: v.confidence, ...(v.unavailable ? { unavailable: true as const } : {}) });
      if (!v.verified) continue;
      const recorded = await recordVerified({ workerId: worker.id, workspaceId: worker.workspaceId, taskId: worker.taskId, closedRepo, prNumber, cand, method: v.method!, confidence: v.confidence, via: opts.via });
      if (recorded?.outcome === 'deferred') return deferOrExhaust(cand, v.prUrl!, recorded.reason, v.confidence);
      if (recorded) return recorded;
    }
    return null;
  };

  const ranked = () => [...candidates.values()].sort((a, b) => b.score - a.score);
  const first = await tryAll(ranked());
  if (first) return first;
  if (gh.interrupted) return deferInterrupted();

  // (c) Nothing nominated it, or nothing nominated verified: merged PRs in
  // this repo since the closed PR opened that touch the same files.
  const seen = new Set(candidates.keys());
  for (const c of await overlapCandidates({ gh, inst: closedInst, repo: closedRepo, closed, closedFiles, filesCache })) {
    if (!seen.has(key(c.repo, c.prNumber))) add(c);
  }
  if (gh.interrupted) return deferInterrupted();
  const second = await tryAll(ranked().filter(c => !seen.has(key(c.repo, c.prNumber))));
  if (second) return second;
  if (gh.interrupted) return deferInterrupted();

  // No proof. Offer the strongest merged candidate, and record nothing durable.
  const best = merged.sort((a, b) => (b.score + b.confidence * 0.1) - (a.score + a.confidence * 0.1))[0];
  const suggestion: SupersessionSuggestion | null = best
    ? {
        repo: best.repo,
        prNumber: best.prNumber,
        prUrl: best.prUrl,
        signal: best.signal,
        why: best.unavailable
          ? `${best.why}; GitHub did not return its changes, so its content was not compared`
          : best.confidence > 0
            ? `${best.why}; ${Math.round(best.confidence * 100)}% of this PR's added lines are in it, short of the bar to record it automatically`
            : `${best.why}; none of this PR's added lines were found in it`,
        score: Math.round(best.score * 100) / 100,
        ...(best.unavailable ? { contentUnavailable: true as const } : { contentRatio: Math.round(best.confidence * 100) / 100 }),
      }
    : null;
  const scan: SupersessionScan = {
    scannedAt: now.toISOString(),
    candidatesChecked: checked,
    suggestion,
    ...(prevScan?.dismissed?.length ? { dismissed: prevScan.dismissed } : {}),
    ...(judged.size ? { judged: judgedList() } : {}),
  };
  await db.update(workers)
    .set({ supersessionScan: scan, supersessionScannedAt: now })
    .where(scanRows);

  if (suggestion) {
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
      surface: SURFACE[opts.via],
      outcome: 'deferred',
      reason: 'supersession candidate found but not content-verified: suggestion only, no edge',
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id,
      detail: { prNumber, repo: closedRepo, candidate: { repo: suggestion.repo, prNumber: suggestion.prNumber }, signal: suggestion.signal, confidence: best!.confidence },
      callerOrigin: 'system',
    });
    return { outcome: 'suggested', suggestion, candidatesChecked: checked };
  }
  return { outcome: 'none', candidatesChecked: checked };
}

/**
 * A closed integration-refresh PR: is everything it set out to do already in its integration
 * branch? The same proof pr-supersession-refresh.ts demands before retiring one
 * (`verifyRefreshInBranch`: ancestry, then every migration by identical SQL and every added line),
 * whoever put the work there. The answer is kept on the scan as `refreshCheck`, never as a
 * suggestion: no PR is offered as its replacement, and nothing durable is recorded. When a newer
 * merged refresh carries it, that sweep (`sweepSupersededRefreshPrs`, which also takes closed
 * refresh PRs) records the edge.
 *
 *  - landed      → stamped scanned; the mission reads "its work is in <branch>".
 *  - unique_work → stamped scanned; the mission reads "its closure loses work", with the reason.
 *  - a read GitHub would not answer → deferred like any other scan, then `unavailable` once the
 *    deferral runs out; never read as either verdict.
 *
 * Repeating it is safe: each run re-reads GitHub rather than trusting the last answer, writes
 * the same stamp, and announces a verdict (gate event) only when it differs from the last one.
 */
async function checkClosedRefresh(a: {
  gh: GhReader;
  opts: Parameters<typeof detectPrSupersession>[0];
  now: Date;
  worker: { id: string; taskId: string | null; workspaceId: string | null; supersessionScan: SupersessionScan | null };
  refresh: IntegrationRefreshContext;
  context: unknown;
  closedRepo: string;
  prNumber: number;
  inst: number;
  scanRows: ReturnType<typeof or>;
}): Promise<DetectResult> {
  const { gh, now, worker, refresh, closedRepo, prNumber, inst, scanRows } = a;
  const prevScan: SupersessionScan | null = worker.supersessionScan ?? null;
  const api = (i: number, path: string) => gh.call(i, path);

  const settle = async (check: Omit<RefreshCheck, 'at'>): Promise<DetectResult> => {
    const refreshCheck: RefreshCheck = { ...check, at: now.toISOString() };
    const { deferral: _done, judged: _j, lastAttemptAt: _l, ...rest } = prevScan ?? { scannedAt: '', candidatesChecked: 0, suggestion: null };
    await db.update(workers)
      .set({ supersessionScan: { ...rest, scannedAt: now.toISOString(), candidatesChecked: 0, suggestion: null, refreshCheck }, supersessionScannedAt: now })
      .where(scanRows);
    if (check.outcome === 'unique_work' && prevScan?.refreshCheck?.outcome !== 'unique_work') {
      fireGateEvent({
        gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
        surface: SURFACE[a.opts.via],
        outcome: 'stranded',
        reason: `closed integration-refresh PR carries work its branch does not have: ${check.reason}`,
        workspaceId: worker.workspaceId ?? null,
        taskId: worker.taskId ?? null,
        workerId: worker.id,
        detail: { kind: 'refresh_unique_work', prNumber, repo: closedRepo, branch: check.branch },
        callerOrigin: 'system',
      });
    }
    return { outcome: 'none', candidatesChecked: 0 };
  };

  // A read that did not answer: no verdict. Deferred, then settled as unavailable once that runs out.
  const defer = async (branch: string | null, reason: string): Promise<DetectResult> => {
    const { state, exhausted } = nextDeferral(deferralOf(prevScan?.deferral), reason, now);
    if (exhausted) return settle({ outcome: 'unavailable', branch, reason: `could not be checked for ${state.count} sweep(s): ${reason}` });
    const base: SupersessionScan = prevScan ?? { scannedAt: '', candidatesChecked: 0, suggestion: null };
    await db.update(workers).set({ supersessionScan: { ...base, deferral: state, lastAttemptAt: now.toISOString() } }).where(scanRows);
    return { outcome: 'deferred', reason, candidatesChecked: 0 };
  };

  let pr: GhPr & { base?: { ref?: string } };
  try {
    pr = await gh.call(inst, `/repos/${closedRepo}/pulls/${prNumber}`);
  } catch (err) {
    return defer(null, `could not read ${closedRepo}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pr?.merged) return { outcome: 'skipped', reason: 'PR is merged on GitHub' };
  const branch = refreshFiledFor(a.context) ?? pr?.base?.ref ?? null;
  const head = pr?.head?.sha;
  // What the proof needs and the PR will never gain: settled as unavailable, not retried.
  if (!branch || !branch.startsWith(MISSION_BRANCH_PREFIX)) return settle({ outcome: 'unavailable', branch, reason: `${branch ?? 'its base'} is not a mission integration branch` });
  if (!refresh.trunk) return settle({ outcome: 'unavailable', branch, reason: 'the refresh does not record which trunk it merged' });
  if (!head) return settle({ outcome: 'unavailable', branch, reason: 'the PR has no head sha' });

  const v = await verifyRefreshInBranch({ installationId: inst, repo: closedRepo, branch, trunk: refresh.trunk, refresh, prHeadSha: head, api });
  if (gh.interrupted || (!v.ok && v.transient)) return defer(branch, v.ok ? `a GitHub read was cut short (${gh.interrupted})` : v.reason);
  if (!v.ok) return settle({ outcome: 'unique_work', branch, reason: v.reason });
  return settle({
    outcome: 'landed', branch,
    reason: `its ${refresh.trunk} merge and mission head are in ${branch}'s history, and `
      + (v.filesChecked
        ? `every line of the ${v.filesChecked} file(s) it changes on top of ${refresh.trunk} is there`
          + (v.migrationsMatched ? ` (${v.migrationsMatched} migration(s) matched by identical SQL)` : '')
        : `it changes nothing on top of ${refresh.trunk}`),
    filesChecked: v.filesChecked, migrationsMatched: v.migrationsMatched,
  });
}

function sameKey(c: { repo: string; prNumber: number }, repo: string, n: number) {
  return c.prNumber === n && c.repo.toLowerCase() === repo.toLowerCase();
}

function refOf(c: { repo: string; prNumber: number }, home: string) {
  return c.repo.toLowerCase() === home.toLowerCase() ? `#${c.prNumber}` : `${c.repo}#${c.prNumber}`;
}

async function recordVerified(opts: {
  workerId: string;
  workspaceId: string | null;
  taskId: string | null;
  closedRepo: string;
  prNumber: number;
  cand: Candidate;
  method: SupersessionMethod;
  confidence: number;
  via: DetectVia;
}): Promise<DetectResult | null> {
  const { cand, closedRepo } = opts;
  const crossRepo = cand.repo.toLowerCase() !== closedRepo.toLowerCase();
  const result = await recordPrSupersession({
    workerId: opts.workerId,
    supersedingPrNumber: cand.prNumber,
    ...(crossRepo ? { supersedingRepo: cand.repo } : {}),
    reason: `auto: content verified in ${refOf(cand, closedRepo)} (method: ${opts.method})`,
    recordedBy: AUTO_SUPERSESSION_ACTOR,
    caller: 'system',
  });
  if (!result.ok && isOutageAnswer(result.door?.body)) {
    // The control plane did not answer: not a judgement on the candidate. Deferred, never a suggestion.
    // A refusal or the command's own failure is deterministic and falls through to a suggestion below.
    console.warn(`[pr-supersession-detect] verified ${refOf(cand, closedRepo)}; recording deferred, the control plane did not answer: ${result.error}`);
    return { outcome: 'deferred', reason: result.error, candidatesChecked: 0 };
  }
  if (!result.ok) {
    // Proven content but the write refused (repo outside the mission, say):
    // fall through and treat it as a suggestion a person can judge.
    console.warn(`[pr-supersession-detect] verified ${refOf(cand, closedRepo)} but the record was refused: ${result.error}`);
    return null;
  }
  fireGateEvent({
    gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
    surface: SURFACE[opts.via],
    outcome: 'accepted',
    reason: `closed PR auto-recorded as superseded: content verified (${opts.method})`,
    workspaceId: opts.workspaceId,
    taskId: opts.taskId,
    workerId: opts.workerId,
    detail: {
      prNumber: opts.prNumber,
      repo: closedRepo,
      supersedingRepo: cand.repo,
      supersedingPrNumber: cand.prNumber,
      method: opts.method,
      confidence: Math.round(opts.confidence * 1000) / 1000,
      signal: cand.signal,
      recordedBy: AUTO_SUPERSESSION_ACTOR,
    },
    callerOrigin: 'system',
  });
  return { outcome: 'recorded', repo: cand.repo, prNumber: cand.prNumber, method: opts.method, confidence: opts.confidence };
}

/** Merged PRs in `repo` since the closed PR opened, ranked by shared files. */
async function overlapCandidates(opts: {
  gh: GhReader;
  inst: number;
  repo: string;
  closed: GhPr;
  closedFiles: DiffFile[];
  filesCache: Map<string, DiffFile[]>;
}): Promise<Candidate[]> {
  const closedPaths = opts.closedFiles.filter(f => f.status !== 'removed');
  if (closedPaths.length === 0) return [];
  const since = opts.closed.created_at ? Date.parse(opts.closed.created_at) : 0;
  const recent = await opts.gh.call(opts.inst, `/repos/${opts.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${DETECT_LIMITS.overlapScan}`).catch(() => []);
  const merged = (Array.isArray(recent) ? recent as GhPr[] : [])
    .filter(p => p.merged_at && Date.parse(p.merged_at) >= since && p.number !== opts.closed.number)
    .slice(0, DETECT_LIMITS.overlapFetch);

  const out: Candidate[] = [];
  for (const p of merged) {
    if (opts.gh.stopped()) break;
    const files = await listFiles(opts.gh, opts.inst, opts.repo, p.number).catch(() => null);
    if (opts.gh.interrupted) break;
    // An unread list is not cached: a later content check must not take it for an empty diff.
    if (!files) continue;
    opts.filesCache.set(key(opts.repo, p.number), files);
    const shared = closedPaths.filter(f => mapPath(f.filename, files)).length;
    if (shared === 0) continue;
    const overlap = shared / closedPaths.length;
    out.push({
      repo: opts.repo,
      prNumber: p.number,
      signal: 'file_overlap',
      score: SIGNAL_SCORE.file_overlap + 0.4 * overlap,
      why: `merged after this PR opened and touches ${shared} of its ${closedPaths.length} file(s)`,
    });
  }
  return out;
}

// ─── Backfill ────────────────────────────────────────────────────────────────

/** A scanned PR is looked at again after this long — new merges may prove it. */
export const RESCAN_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Rows per sweep run; the sweep shares a 60s cron with everything else. */
export const SWEEP_CAP = 8;

export interface ClosedPrSweepResult {
  candidates: number;
  recorded: number;
  suggested: number;
  none: number;
  skipped: number;
  /**
   * Left unstamped for the next tick: verified but not recorded (the kernel's host did not take it),
   * a GitHub read that timed out, or the row in flight when the sweep's budget ran out.
   */
  deferred: number;
  /** Rows never started because the sweep's budget ran out; the next tick takes them first. */
  budgetStopped: number;
  /** Each scanned PR (`owner/repo#n`), how long it took and how it ended, in sweep order. */
  prs: Array<{ pr: string; ms: number; outcome: DetectResult['outcome'] | 'error' }>;
}

/**
 * The hourly backfill: completed mission tasks whose PR closed unmerged with
 * no edge, no abandonment, and no recent scan. Covers webhook misses and the
 * backlog that predates the webhook door.
 */
/**
 * The sweep's queue: completed mission tasks whose PR closed unmerged with no edge, no abandonment
 * and no scan inside the rescan window. Never-tried rows first, then by when each was last looked at:
 * the later of its last finished scan and its last unfinished attempt (`supersessionScan.lastAttemptAt`),
 * so a row the budget keeps cutting off moves behind the others instead of holding the front.
 */
export async function closedPrSweepQueue(now: Date, limit: number = SWEEP_CAP * 3): Promise<Array<{ id: string; prUrl: string | null }>> {
  const cutoff = new Date(now.getTime() - RESCAN_AFTER_MS);
  const lastAttempt = sql`(case when ${workers.supersessionScan}->>'lastAttemptAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${workers.supersessionScan}->>'lastAttemptAt')::timestamptz end)`;
  return db
    .select({ id: workers.id, prUrl: workers.prUrl })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      eq(workers.prLifecycleStatus, 'closed'),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      isNull(workers.supersededByPrNumber),
      isNull(workers.abandonedAt),
      or(isNull(workers.supersessionScannedAt), lt(workers.supersessionScannedAt, cutoff)),
      isNotNull(tasks.missionId),
      inArray(tasks.status, ['completed']),
    ))
    .orderBy(sql`greatest(${workers.supersessionScannedAt}, ${lastAttempt}) asc nulls first`, asc(workers.updatedAt))
    .limit(limit);
}

export async function sweepClosedUnsupersededPrs(
  now: Date = new Date(),
  limits: { budgetMs: number; requestTimeoutMs: number } = SWEEP_LIMITS,
): Promise<ClosedPrSweepResult> {
  const budget = AbortSignal.timeout(limits.budgetMs);
  const result: ClosedPrSweepResult = { candidates: 0, recorded: 0, suggested: 0, none: 0, skipped: 0, deferred: 0, budgetStopped: 0, prs: [] };
  const rows = await closedPrSweepQueue(now);

  // One scan per PR, not per row sharing it.
  const seen = new Set<string>();
  const picked = rows.filter(r => {
    if (!r.prUrl || seen.has(r.prUrl)) return false;
    seen.add(r.prUrl);
    return true;
  }).slice(0, SWEEP_CAP);
  result.candidates = picked.length;

  for (const [i, r] of picked.entries()) {
    // Out of time: the rest wait, unstamped, and sort first next tick (never scanned, or scanned longest ago).
    if (budget.aborted) {
      result.budgetStopped = picked.length - i;
      break;
    }
    const started = Date.now();
    let failed = false;
    const out = await detectPrSupersession({ workerId: r.id, via: 'sweep', now, limits: { budget, requestTimeoutMs: limits.requestTimeoutMs, first: i === 0 } }).catch(err => {
      console.error(`[pr-supersession-detect] sweep failed for ${r.prUrl}:`, err);
      failed = true;
      // A failure while the budget was running out is not a verdict on the row.
      return (budget.aborted
        ? { outcome: 'deferred', reason: 'error after the sweep budget ran out', candidatesChecked: 0 }
        : { outcome: 'skipped', reason: 'error' }) as DetectResult;
    });
    result.prs.push({ pr: shortPrRef(r.prUrl), ms: Date.now() - started, outcome: failed && out.outcome === 'skipped' ? 'error' : out.outcome });
    if (out.outcome === 'skipped') {
      result.skipped++;
      // Stamp it anyway so an unreadable PR does not starve the rest of the queue.
      await db.update(workers).set({ supersessionScannedAt: now }).where(eq(workers.id, r.id)).catch(() => {});
    } else {
      result[out.outcome]++;
    }
  }
  return result;
}

/** `owner/repo#n` for the sweep's per-PR timing line. */
function shortPrRef(prUrl: string | null): string {
  const repo = repoFullNameFromPrUrl(prUrl);
  const n = prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return repo && n ? `${repo}#${n}` : String(prUrl);
}

// ─── Re-check on merge (b6cfdbb9) ────────────────────────────────────────────

/** Closed PRs looked at again per merge. Each is a full scan (several GitHub reads), run in after(). */
export const RESCAN_ON_MERGE_CAP = 5;

const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const PR_REF_RE = /(?:^|[^\w/#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/** Every PR a text names: `#n`, `owner/repo#n` and pull URLs, deduplicated. Not a claim of supersession. */
export function prRefsIn(text: string | null | undefined, defaultRepo: string): Array<{ repo: string; prNumber: number }> {
  const out: Array<{ repo: string; prNumber: number }> = [];
  const seen = new Set<string>();
  const push = (repo: string, n: number) => {
    if (!Number.isInteger(n) || n <= 0) return;
    const k = `${repo.toLowerCase()}#${n}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ repo, prNumber: n });
  };
  const t = text ?? '';
  for (const m of t.matchAll(PR_URL_RE)) push(m[1], Number(m[2]));
  for (const m of t.replace(PR_URL_RE, ' ').matchAll(PR_REF_RE)) push(m[1] ?? defaultRepo, Number(m[2]));
  return out;
}

/**
 * A PR merged: look again at the closed-unmerged PRs whose work it may carry. The scan at close
 * time runs before a re-land exists (audit case: the re-land opened and merged after the close,
 * so its scan deferred and nothing re-ran it for days). Nominated, never assumed:
 *  - a closed PR the merged one names in its title or body ("re-land of #n"),
 *  - a closed PR whose last scan already suggested this one,
 *  - a closed PR of a sibling task in the merged task's mission.
 * Each is then scanned in full, so an edge is still recorded only when the content verifies.
 * Never throws.
 */
/**
 * Find closed-unmerged PRs from task-lineage relationships that may be superseded
 * by a merged PR. Returns taskIds of related tasks whose workers' closed PRs should
 * be nominated for supersession when the merged PR's task merged.
 */
async function findTaskLineageForSupersession(taskId: string): Promise<string[]> {
  const relatedTasks: string[] = [taskId];

  // Find the task's parent and children to include all related attempts
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { parentTaskId: true, taskClass: true },
  });

  if (!task) return relatedTasks;

  // If this is an attempt task, add its parent (the task it's an attempt of)
  if (task.parentTaskId) {
    relatedTasks.push(task.parentTaskId);
  }

  // Find all attempt children of this task (tasks where parentTaskId = taskId and taskClass='attempt')
  const children = await db.query.tasks.findMany({
    where: sqlWhere(and(eq(tasks.parentTaskId, taskId), sql`${tasks.taskClass} = 'attempt'`)),
    columns: { id: true },
  });

  for (const child of children) {
    relatedTasks.push(child.id);
  }

  return relatedTasks;
}

export async function rescanOnMerge(p: {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  taskId: string | null;
  now?: Date;
}): Promise<{ nominated: number; results: Array<{ prUrl: string; outcome: DetectResult['outcome'] | 'error' }> }> {
  const repo = normalizeRepoFullName(p.repoFullName) ?? p.repoFullName;
  const selfUrl = prUrlFor(repo, p.prNumber);
  const results: Array<{ prUrl: string; outcome: DetectResult['outcome'] | 'error' }> = [];
  try {
    const inst = (await createTeamInstallationResolver().forWorkspace(repo, p.workspaceId)).installationId;
    const merged: GhPr | null = inst
      ? await githubApi(inst, `/repos/${repo}/pulls/${p.prNumber}`, { signal: AbortSignal.timeout(SWEEP_LIMITS.requestTimeoutMs) }).catch(() => null)
      : null;
    const named = prRefsIn(`${merged?.title ?? ''}\n${merged?.body ?? ''}`, repo)
      .map(r => prUrlFor(r.repo, r.prNumber))
      .filter(u => u.toLowerCase() !== selfUrl.toLowerCase());
    const missionId = p.taskId
      ? (await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, p.taskId)), columns: { missionId: true } }))?.missionId ?? null
      : null;
    const suggestedThis = and(
      sql`${workers.supersessionScan}->'suggestion'->>'prNumber' = ${String(p.prNumber)}`,
      sql`lower(${workers.supersessionScan}->'suggestion'->>'repo') = ${repo.toLowerCase()}`,
    );

    // Find task-lineage related tasks (parent, children) whose closed PRs should be nominated
    const relatedTaskIds = p.taskId ? await findTaskLineageForSupersession(p.taskId) : [];

    const nominee = or(
      and(eq(workers.workspaceId, p.workspaceId), or(suggestedThis, ...(named.length ? [inArray(workers.prUrl, named)] : []))),
      ...(missionId ? [eq(tasks.missionId, missionId)] : []),
      ...(relatedTaskIds.length ? [inArray(tasks.id, relatedTaskIds)] : []),
    );
    const rows = await db
      .select({ id: workers.id, prUrl: workers.prUrl, missionId: tasks.missionId })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .where(and(
        eq(workers.prLifecycleStatus, 'closed'),
        isNotNull(workers.prUrl),
        isNull(workers.mergedAt),
        isNull(workers.supersededByPrNumber),
        isNull(workers.abandonedAt),
        nominee,
      ))
      .orderBy(desc(workers.updatedAt))
      .limit(RESCAN_ON_MERGE_CAP * 3);
    const seen = new Set<string>([selfUrl.toLowerCase()]);
    const picked = rows.filter(r => {
      const k = r.prUrl?.toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, RESCAN_ON_MERGE_CAP);
    const namedSet = new Set(named.map(u => u.toLowerCase()));
    for (const r of picked) {
      const sibling = !namedSet.has(r.prUrl!.toLowerCase()) && missionId != null && r.missionId === missionId;
      const ref = refOf({ repo, prNumber: p.prNumber }, repoFullNameFromPrUrl(r.prUrl) ?? repo);
      const nominee = {
        repo, prNumber: p.prNumber,
        signal: (sibling ? 'sibling_task' : 'cross_reference') as SupersessionSignal,
        why: sibling ? `${ref} merged in the same mission after this PR closed` : `${ref} names this PR or was suggested for it, and merged after it closed`,
      };
      const out = await detectPrSupersession({ workerId: r.id, via: 'merge', now: p.now, nominee, limits: { requestTimeoutMs: SWEEP_LIMITS.requestTimeoutMs } })
        .catch(err => {
          console.error(`[pr-supersession-detect] re-check on merge of ${repo}#${p.prNumber} failed for ${r.prUrl}:`, err);
          return null;
        });
      results.push({ prUrl: r.prUrl!, outcome: out?.outcome ?? 'error' });
    }
    return { nominated: picked.length, results };
  } catch (err) {
    console.error(`[pr-supersession-detect] re-check on merge of ${repo}#${p.prNumber} failed:`, err);
    return { nominated: 0, results };
  }
}
