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
 * Two doors: the pull_request.closed webhook (merged=false), and the hourly
 * pr-reconcile backfill (`sweepClosedUnsupersededPrs`) for webhook misses and
 * PRs that closed before this existed.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { prShipState, type SupersessionScan, type SupersessionSignal, type SupersessionSuggestion } from '@buildd/core/pr-shipped';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { recordPrSupersession, supersessionRepoScope } from '@/lib/pr-supersession';
import { verifyByContent, verifyByPatchId, mapPath, parseSupersessionClaims, significantAddedLines, type DiffFile } from '@/lib/pr-supersession-verify';
import { normalizeRepoFullName, prUrlFor, repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { installationIdForRepo } from '@/lib/workspace-installation';

export type DetectVia = 'webhook' | 'sweep';

export type SupersessionMethod = 'patch-id' | 'content';

export type DetectResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'recorded'; repo: string; prNumber: number; method: SupersessionMethod; confidence: number }
  | { outcome: 'suggested'; suggestion: SupersessionSuggestion; candidatesChecked: number }
  | { outcome: 'none'; candidatesChecked: number };

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

async function listFiles(inst: number, repo: string, n: number): Promise<DiffFile[]> {
  const files = await githubApi(inst, `/repos/${repo}/pulls/${n}/files?per_page=100`);
  return Array.isArray(files) ? files : [];
}

async function commitDiffs(inst: number, repo: string, n: number): Promise<DiffFile[][]> {
  const commits = await githubApi(inst, `/repos/${repo}/pulls/${n}/commits?per_page=${DETECT_LIMITS.maxPatchIdCommits}`);
  const out: DiffFile[][] = [];
  for (const c of Array.isArray(commits) ? commits : []) {
    // A merge commit (two parents) carries no change of its own.
    if (Array.isArray(c?.parents) && c.parents.length > 1) continue;
    const full = await githubApi(inst, `/repos/${repo}/commits/${c.sha}`);
    out.push(Array.isArray(full?.files) ? full.files : []);
  }
  return out;
}

async function fileContent(inst: number, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await githubApi(inst, `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
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
  closedRepo: string;
  closed: GhPr;
  closedFiles: DiffFile[];
  closedInst: number;
  cand: Candidate;
  inst: number;
  filesCache: Map<string, DiffFile[]>;
}): Promise<CandidateVerdict> {
  const { cand, inst } = opts;
  const pr: GhPr | null = await githubApi(inst, `/repos/${cand.repo}/pulls/${cand.prNumber}`).catch(() => null);
  if (!pr?.merged) return { merged: false, verified: false, confidence: 0 };
  const prUrl = pr.html_url ?? prUrlFor(cand.repo, cand.prNumber);

  const k = key(cand.repo, cand.prNumber);
  let candFiles = opts.filesCache.get(k);
  if (!candFiles) {
    candFiles = await listFiles(inst, cand.repo, cand.prNumber).catch(() => []);
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
      const c = await fileContent(inst, cand.repo, t.filename, pr.merge_commit_sha);
      if (c != null) contents.set(t.filename, c);
    }
  }

  const content = verifyByContent(opts.closedFiles, candFiles, contents);
  if (content.verified) return { merged: true, verified: true, method: 'content', confidence: content.ratio, prUrl };

  const small = (n: number | undefined) => typeof n === 'number' && n > 0 && n <= DETECT_LIMITS.maxPatchIdCommits;
  if (small(opts.closed.commits) && small(pr.commits)) {
    try {
      const [a, b] = await Promise.all([
        commitDiffs(opts.closedInst, opts.closedRepo, opts.closed.number),
        commitDiffs(inst, cand.repo, cand.prNumber),
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
export async function detectPrSupersession(opts: { workerId: string; via: DetectVia; now?: Date }): Promise<DetectResult> {
  const now = opts.now ?? new Date();
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, opts.workerId),
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
  if (prShipState(worker) !== 'closed_unsuperseded') return { outcome: 'skipped', reason: 'not closed-unsuperseded' };

  const closedRepo = repoFullNameFromPrUrl(worker.prUrl);
  const prNumber = worker.prNumber;
  if (!closedRepo || !prNumber) return { outcome: 'skipped', reason: 'no parsable PR url' };

  const installationFor = installationResolver();
  const closedInst = await installationFor(closedRepo);
  if (!closedInst) return { outcome: 'skipped', reason: `no installation for ${closedRepo}` };

  let closed: GhPr;
  let closedFiles: DiffFile[];
  try {
    closed = await githubApi(closedInst, `/repos/${closedRepo}/pulls/${prNumber}`);
    if (closed?.merged) return { outcome: 'skipped', reason: 'PR is merged on GitHub' };
    closedFiles = await listFiles(closedInst, closedRepo, prNumber);
  } catch (err) {
    console.warn(`[pr-supersession-detect] could not read ${closedRepo}#${prNumber}:`, err);
    return { outcome: 'skipped', reason: 'could not read the closed PR' };
  }

  const prevScan: SupersessionScan | null = worker.supersessionScan ?? null;
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
  const comments = await githubApi(closedInst, `/repos/${closedRepo}/issues/${prNumber}/comments?per_page=50`).catch(() => []);
  for (const cm of Array.isArray(comments) ? comments : []) {
    for (const c of parseSupersessionClaims(cm?.body, closedRepo)) {
      add({ ...c, signal: 'claim', score: SIGNAL_SCORE.claim, why: `a comment on this PR says it was superseded by ${refOf(c, closedRepo)}` });
    }
  }
  const timeline = await githubApi(closedInst, `/repos/${closedRepo}/issues/${prNumber}/timeline?per_page=100`).catch(() => []);
  for (const ev of Array.isArray(timeline) ? timeline : []) {
    const issue = ev?.event === 'cross-referenced' ? ev?.source?.issue : null;
    if (!issue?.pull_request || typeof issue.number !== 'number') continue;
    const repo = normalizeRepoFullName(issue.repository?.full_name) ?? closedRepo;
    add({ repo, prNumber: issue.number, signal: 'cross_reference', score: SIGNAL_SCORE.cross_reference, why: `${refOf({ repo, prNumber: issue.number }, closedRepo)} references this PR` });
  }

  // (b) Merged PRs from sibling tasks in the same mission, any repo.
  const missionId = worker.task?.missionId ?? null;
  if (missionId) {
    const siblings = await db.query.tasks.findMany({
      where: eq(tasks.missionId, missionId),
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
  let checked = 0;

  const tryAll = async (list: Candidate[]): Promise<DetectResult | null> => {
    for (const cand of list) {
      if (checked >= DETECT_LIMITS.maxVerify) break;
      const inst = await installationFor(cand.repo);
      if (!inst) continue;
      checked++;
      const v = await verifyCandidate({ closedRepo, closed, closedFiles, closedInst, cand, inst, filesCache })
        .catch(err => {
          console.warn(`[pr-supersession-detect] verify failed for ${key(cand.repo, cand.prNumber)}:`, err);
          return { merged: false, verified: false, confidence: 0 } as CandidateVerdict;
        });
      if (!v.merged) continue;
      merged.push({ ...cand, prUrl: v.prUrl!, confidence: v.confidence });
      if (!v.verified) continue;
      const recorded = await recordVerified({ workerId: worker.id, workspaceId: worker.workspaceId, taskId: worker.taskId, closedRepo, prNumber, cand, method: v.method!, confidence: v.confidence, via: opts.via });
      if (recorded) return recorded;
    }
    return null;
  };

  const ranked = () => [...candidates.values()].sort((a, b) => b.score - a.score);
  const first = await tryAll(ranked());
  if (first) return first;

  // (c) Nothing nominated it, or nothing nominated verified: merged PRs in
  // this repo since the closed PR opened that touch the same files.
  const seen = new Set(candidates.keys());
  for (const c of await overlapCandidates({ inst: closedInst, repo: closedRepo, closed, closedFiles, filesCache })) {
    if (!seen.has(key(c.repo, c.prNumber))) add(c);
  }
  const second = await tryAll(ranked().filter(c => !seen.has(key(c.repo, c.prNumber))));
  if (second) return second;

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
  };
  await db.update(workers)
    .set({ supersessionScan: scan, supersessionScannedAt: now })
    .where(or(eq(workers.id, worker.id), and(eq(workers.prUrl, worker.prUrl!), isNull(workers.mergedAt))));

  if (suggestion) {
    fireGateEvent({
      gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
      surface: opts.via === 'sweep' ? 'cron pr-reconcile' : 'webhook pull_request.closed',
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
  });
  if (!result.ok) {
    // Proven content but the write refused (repo outside the mission, say):
    // fall through and treat it as a suggestion a person can judge.
    console.warn(`[pr-supersession-detect] verified ${refOf(cand, closedRepo)} but the record was refused: ${result.error}`);
    return null;
  }
  fireGateEvent({
    gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
    surface: opts.via === 'sweep' ? 'cron pr-reconcile' : 'webhook pull_request.closed',
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
  inst: number;
  repo: string;
  closed: GhPr;
  closedFiles: DiffFile[];
  filesCache: Map<string, DiffFile[]>;
}): Promise<Candidate[]> {
  const closedPaths = opts.closedFiles.filter(f => f.status !== 'removed');
  if (closedPaths.length === 0) return [];
  const since = opts.closed.created_at ? Date.parse(opts.closed.created_at) : 0;
  const recent = await githubApi(opts.inst, `/repos/${opts.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${DETECT_LIMITS.overlapScan}`).catch(() => []);
  const merged = (Array.isArray(recent) ? recent as GhPr[] : [])
    .filter(p => p.merged_at && Date.parse(p.merged_at) >= since && p.number !== opts.closed.number)
    .slice(0, DETECT_LIMITS.overlapFetch);

  const out: Candidate[] = [];
  for (const p of merged) {
    const files = await listFiles(opts.inst, opts.repo, p.number).catch(() => [] as DiffFile[]);
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
}

/**
 * The hourly backfill: completed mission tasks whose PR closed unmerged with
 * no edge, no abandonment, and no recent scan. Covers webhook misses and the
 * backlog that predates the webhook door.
 */
export async function sweepClosedUnsupersededPrs(now: Date = new Date()): Promise<ClosedPrSweepResult> {
  const result: ClosedPrSweepResult = { candidates: 0, recorded: 0, suggested: 0, none: 0, skipped: 0 };
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

  for (const r of picked) {
    const out = await detectPrSupersession({ workerId: r.id, via: 'sweep', now }).catch(err => {
      console.error(`[pr-supersession-detect] sweep failed for ${r.prUrl}:`, err);
      return { outcome: 'skipped', reason: 'error' } as DetectResult;
    });
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
