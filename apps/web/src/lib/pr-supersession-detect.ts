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
 * Three doors: the pull_request.closed webhook (merged=false) for a legacy PR;
 * the workflow kernel's `scan_supersession` effect for a PR it owns (T18), so
 * the scan is owed durably rather than run in a request; and the hourly
 * pr-reconcile backfill (`sweepClosedUnsupersededPrs`) for webhook misses and
 * PRs that closed before this existed. Whichever door finds the proof, the
 * edge is written by `recordPrSupersession`, which hands a kernel-owned PR to
 * T20 (docs/specs/workflow-state-kernel.md §13.8).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { prShipState, type SupersessionScan, type SupersessionSignal, type SupersessionSuggestion } from '@buildd/core/pr-shipped';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { recordPrSupersession, supersessionRepoScope } from '@/lib/pr-supersession';
import { deferralOf, isOutageAnswer, nextDeferral } from '@/lib/control-plane-deferral';
import { verifyByContent, verifyByPatchId, mapPath, parseSupersessionClaims, significantAddedLines, type DiffFile } from '@/lib/pr-supersession-verify';
import { normalizeRepoFullName, prUrlFor, repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { installationIdForRepo } from '@/lib/workspace-installation';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/** `kernel`: the workflow kernel's `scan_supersession` effect for a PR it owns (T18). */
export type DetectVia = 'webhook' | 'sweep' | 'kernel';

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
 * the next tick, keeping the candidates it did judge (`SupersessionScan.judged`). A request timeout
 * counts toward the control-plane deferral cap (lib/control-plane-deferral.ts); a pass budget stop
 * does not, because running out of pass time is not that PR's fault.
 */
export interface DetectLimits {
  /** Each GitHub call is abandoned after this long. */
  requestTimeoutMs?: number;
  /** The pass's own clock: when it fires, every call in flight is abandoned and no new one starts. */
  budget?: AbortSignal;
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
 */
class GhReader {
  interrupted: Interruption | null = null;
  constructor(private readonly limits: DetectLimits = {}) {}

  get bounded() {
    return this.limits.requestTimeoutMs != null || this.limits.budget != null;
  }

  /** True once the pass's budget is spent; marks the run interrupted. */
  outOfTime(): boolean {
    if (this.limits.budget?.aborted) this.interrupted = 'budget';
    return this.interrupted === 'budget';
  }

  async call(inst: number, path: string) {
    if (!this.bounded) return githubApi(inst, path);
    if (this.outOfTime()) throw new Error(`supersession sweep budget spent before ${path}`);
    const signals: AbortSignal[] = [];
    if (this.limits.requestTimeoutMs != null) signals.push(AbortSignal.timeout(this.limits.requestTimeoutMs));
    if (this.limits.budget) signals.push(this.limits.budget);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      return await githubApi(inst, path, { signal });
    } catch (err) {
      if (signal.aborted) {
        // The budget outranks a request timeout: it is what the rest of the pass must stop for.
        this.interrupted = this.limits.budget?.aborted ? 'budget' : (this.interrupted ?? 'timeout');
      }
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
}

const SURFACE: Record<DetectVia, string> = {
  webhook: 'webhook pull_request.closed',
  sweep: 'cron pr-reconcile',
  kernel: 'workflow scan_supersession',
};

const key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

/** Installation per repo, cached for one detection run. */
function installationResolver() {
  const cache = new Map<string, Promise<number | null>>();
  return (repo: string) => {
    const k = repo.toLowerCase();
    if (!cache.has(k)) cache.set(k, installationIdForRepo(repo).catch(() => null));
    return cache.get(k)!;
  };
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
}): Promise<CandidateVerdict> {
  const { cand, inst, gh } = opts;
  const pr: GhPr | null = await gh.call(inst, `/repos/${cand.repo}/pulls/${cand.prNumber}`).catch(() => null);
  if (!pr?.merged) return { merged: false, verified: false, confidence: 0 };
  const prUrl = pr.html_url ?? prUrlFor(cand.repo, cand.prNumber);

  const k = key(cand.repo, cand.prNumber);
  let candFiles = opts.filesCache.get(k);
  if (!candFiles) {
    candFiles = await listFiles(gh, inst, cand.repo, cand.prNumber).catch(() => []);
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
  if (content.verified) return { merged: true, verified: true, method: 'content', confidence: content.ratio, prUrl };

  const small = (n: number | undefined) => typeof n === 'number' && n > 0 && n <= DETECT_LIMITS.maxPatchIdCommits;
  if (small(opts.closed.commits) && small(pr.commits)) {
    try {
      const [a, b] = await Promise.all([
        commitDiffs(gh, opts.closedInst, opts.closedRepo, opts.closed.number),
        commitDiffs(gh, inst, cand.repo, cand.prNumber),
      ]);
      const pid = verifyByPatchId(a, b);
      if (pid.verified) return { merged: true, verified: true, method: 'patch-id', confidence: 1, prUrl };
    } catch (err) {
      console.warn(`[pr-supersession-detect] patch-id read failed for ${k}:`, err);
    }
  }
  return { merged: true, verified: false, confidence: content.ratio, prUrl };
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
}): Promise<DetectResult> {
  const now = opts.now ?? new Date();
  const gh = new GhReader(opts.limits);
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, opts.workerId)),
    columns: {
      id: true, taskId: true, workspaceId: true, prUrl: true, prNumber: true, mergedAt: true,
      prLifecycleStatus: true, supersededByPrNumber: true, abandonedAt: true, supersessionScan: true,
    },
    with: {
      task: { columns: { id: true, missionId: true } },
      workspace: { columns: { repo: true }, with: { githubRepo: { columns: { fullName: true } } } },
    },
  });
  if (!worker) return { outcome: 'skipped', reason: 'worker not found' };
  // Already merged, superseded, abandoned or still open: nothing to find.
  if (prShipState({ ...worker, delivery: opts.delivery ?? null }) !== 'closed_unsuperseded') return { outcome: 'skipped', reason: 'not closed-unsuperseded' };

  const closedRepo = repoFullNameFromPrUrl(worker.prUrl);
  const prNumber = worker.prNumber;
  if (!closedRepo || !prNumber) return { outcome: 'skipped', reason: 'no parsable PR url' };

  const installationFor = installationResolver();
  const closedInst = await installationFor(closedRepo);
  if (!closedInst) return { outcome: 'skipped', reason: `no installation for ${closedRepo}` };

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
  const scanRows = or(eq(workers.id, worker.id), and(eq(workers.prUrl, worker.prUrl!), isNull(workers.mergedAt)));
  let checked = 0;

  // A run GitHub or the pass's clock cut short: no verdict is written (no stamp, no suggestion).
  // What it did judge is kept. A request timeout counts toward the deferral cap, the way a
  // control-plane outage does; past the cap the row is settled so it cannot hold the queue forever.
  const deferInterrupted = async (): Promise<DetectResult> => {
    const base: SupersessionScan = prevScan ?? { scannedAt: now.toISOString(), candidatesChecked: checked, suggestion: null };
    if (gh.interrupted === 'budget') {
      const reason = 'the supersession sweep ran out of time';
      if (judged.size > 0) await db.update(workers).set({ supersessionScan: { ...base, judged: judgedList() } }).where(scanRows);
      return { outcome: 'deferred', reason, candidatesChecked: checked };
    }
    const reason = `a GitHub request did not answer within ${opts.limits?.requestTimeoutMs}ms`;
    const { state, exhausted } = nextDeferral(deferralOf(prevScan?.deferral), reason, now);
    if (!exhausted) {
      await db.update(workers).set({ supersessionScan: { ...base, deferral: state, judged: judgedList() } }).where(scanRows);
      return { outcome: 'deferred', reason, candidatesChecked: checked };
    }
    const { deferral: _done, ...rest } = base;
    await db.update(workers)
      .set({ supersessionScan: { ...rest, scannedAt: now.toISOString(), candidatesChecked: checked, suggestion: prevScan?.suggestion ?? null, deferralExhausted: state, judged: judgedList() }, supersessionScannedAt: now })
      .where(scanRows);
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
      surface: SURFACE[opts.via],
      outcome: 'stranded',
      reason: `supersession scan never finished: GitHub did not answer in time for ${state.count} sweep(s); settled without a verdict`,
      workspaceId: worker.workspaceId ?? null,
      taskId: worker.taskId ?? null,
      workerId: worker.id,
      detail: { kind: 'github_timeout_deferral_exhausted', prNumber, repo: closedRepo, deferral: state },
      callerOrigin: 'system',
    });
    return { outcome: 'skipped', reason: `GitHub did not answer for ${state.count} sweep(s); settled without a verdict` };
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
  const merged: Array<Candidate & { prUrl: string; confidence: number }> = [];

  // A verified candidate the control plane did not take: deferred to the next sweep (nothing stamped),
  // until the deferral runs out; then it is filed as a suggestion with why, and a stranded gate event.
  const deferOrExhaust = async (cand: Candidate, candUrl: string, reason: string): Promise<DetectResult> => {
    const { state, exhausted } = nextDeferral(deferralOf(prevScan?.deferral), reason, now);
    const base: SupersessionScan = prevScan ?? { scannedAt: now.toISOString(), candidatesChecked: checked, suggestion: null };
    if (!exhausted) {
      await db.update(workers).set({ supersessionScan: { ...base, deferral: state, judged: judgedList() } }).where(scanRows);
      return { outcome: 'deferred', reason, candidatesChecked: checked };
    }
    const suggestion: SupersessionSuggestion = {
      repo: cand.repo, prNumber: cand.prNumber, prUrl: candUrl, signal: cand.signal,
      why: `${cand.why}; its content verified, but the control plane did not take the record for ${state.count} sweep(s) since ${state.firstAt} (${reason})`,
      score: Math.round(cand.score * 100) / 100,
    };
    const { deferral: _done, ...rest } = base;
    await db.update(workers)
      .set({ supersessionScan: { ...rest, scannedAt: now.toISOString(), candidatesChecked: checked, suggestion, deferralExhausted: state, judged: judgedList() }, supersessionScannedAt: now })
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
      if (gh.outOfTime()) return null;
      const inst = await installationFor(cand.repo);
      if (!inst) continue;
      checked++;
      const k = key(cand.repo, cand.prNumber);
      const prior = judged.get(k);
      const v: CandidateVerdict = prior
        ? { merged: true, verified: prior.verified, method: prior.method, confidence: prior.confidence, prUrl: prior.prUrl }
        : await verifyCandidate({ gh, closedRepo, closed, closedFiles, closedInst, cand, inst, filesCache })
          .catch(err => {
            console.warn(`[pr-supersession-detect] verify failed for ${k}:`, err);
            return { merged: false, verified: false, confidence: 0 } as CandidateVerdict;
          });
      // An abandoned read makes a candidate look unmerged or empty: never judge on it.
      if (gh.interrupted) return null;
      if (!prior && v.merged) {
        judged.set(k, { repo: cand.repo, prNumber: cand.prNumber, prUrl: v.prUrl!, verified: v.verified, ...(v.method ? { method: v.method } : {}), confidence: v.confidence, at: now.toISOString() });
      }
      if (!v.merged) continue;
      merged.push({ ...cand, prUrl: v.prUrl!, confidence: v.confidence });
      if (!v.verified) continue;
      const recorded = await recordVerified({ workerId: worker.id, workspaceId: worker.workspaceId, taskId: worker.taskId, closedRepo, prNumber, cand, method: v.method!, confidence: v.confidence, via: opts.via });
      if (recorded?.outcome === 'deferred') return deferOrExhaust(cand, v.prUrl!, recorded.reason);
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
        why: best.confidence > 0
          ? `${best.why}; ${Math.round(best.confidence * 100)}% of this PR's added lines are in it, short of the bar to record it automatically`
          : `${best.why}; none of this PR's added lines were found in it`,
        score: Math.round(best.score * 100) / 100,
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
    if (opts.gh.outOfTime()) break;
    const files = await listFiles(opts.gh, opts.inst, opts.repo, p.number).catch(() => [] as DiffFile[]);
    if (opts.gh.interrupted) break;
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
export async function sweepClosedUnsupersededPrs(
  now: Date = new Date(),
  limits: { budgetMs: number; requestTimeoutMs: number } = SWEEP_LIMITS,
): Promise<ClosedPrSweepResult> {
  const budget = AbortSignal.timeout(limits.budgetMs);
  const result: ClosedPrSweepResult = { candidates: 0, recorded: 0, suggested: 0, none: 0, skipped: 0, deferred: 0, budgetStopped: 0, prs: [] };
  const cutoff = new Date(now.getTime() - RESCAN_AFTER_MS);
  const rows = await db
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
    .orderBy(sql`${workers.supersessionScannedAt} asc nulls first`, asc(workers.updatedAt))
    .limit(SWEEP_CAP * 3);

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
    const out = await detectPrSupersession({ workerId: r.id, via: 'sweep', now, limits: { budget, requestTimeoutMs: limits.requestTimeoutMs } }).catch(err => {
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
