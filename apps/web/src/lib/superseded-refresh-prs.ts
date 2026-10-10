/**
 * Retire an integration-refresh PR that a newer refresh fully replaced.
 *
 * A mission's integration branch is refreshed with a merge-commit PR
 * (`context.requireMergeCommit`, lib/integration-refresh.ts). When two are open
 * at once — a conflict task retried, or a second trunk merge dispatched while
 * the first sat in review — the newer one lands and the older one is left open,
 * conflicted, and one click from re-introducing work the branch already has.
 * Nothing closed it: the retry-lineage door (lib/retry-pr-supersession.ts,
 * #3161) only walks `attempt` lineage and refuses mission-branch heads, and the
 * closed-PR door (lib/pr-supersession-detect.ts, #3387) only looks at PRs that
 * are already closed.
 *
 * This is the hourly sweep that closes the gap. Nothing durable is written from
 * a claim of "newer, so it supersedes": the older PR is retired only when ALL of
 * these are read from GitHub, not from our rows —
 *
 *   1. the newer refresh PR is merged, into the same integration branch;
 *   2. the older PR's refresh contribution is in the branch's ancestry
 *      (`verifyRefreshLanded`, #4047 — the trunk sha it merged in and the
 *      mission head it started from are both reachable from the branch head);
 *   3. nothing the older PR adds on top of trunk is missing from the branch:
 *      every line it adds is present in the branch's own delta over trunk
 *      (`verifyByContent`, strictly: all of them, not the 90% the closed-PR door
 *      accepts). A regenerated migration with a different number has the same
 *      SQL blob and so counts as present; drizzle's meta snapshot/journal files
 *      are generated per index and are set aside only when every migration
 *      `.sql` the PR adds has such a twin.
 *
 * Any read that fails, any list that may be truncated, any leftover line: the PR
 * stays open and the reason is recorded. Retiring is close → comment (marked, so
 * a retry never double-posts) → `recordPrSupersession` (the one writer of the
 * edge). Every step is idempotent: a PR already closed on GitHub is verified the
 * same way and only gets its edge, so a half-finished run completes on the next.
 * Unrelated PRs are never candidates: only an open refresh PR in the same
 * mission, repo and base branch as a merged, higher-numbered refresh PR is.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { MISSION_BRANCH_PREFIX } from '@buildd/core/mission-integration';
import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { GATE_SLUGS, fireGateEvent } from '@/lib/gate-ledger';
import { effectiveDeltaFiles, integrationRefreshOf, verifyRefreshLanded, type DeltaFile, type IntegrationRefreshContext } from '@/lib/integration-refresh';
import { recordPrSupersession } from '@/lib/pr-supersession';
import { verifyByContent, type DiffFile } from '@/lib/pr-supersession-verify';
import { repoFullNameFromPrUrl } from '@/lib/repo-scope';
import { installationIdForRepo } from '@/lib/workspace-installation';

export const REFRESH_SUPERSESSION_ACTOR = 'system:refresh-supersession';
export const REFRESH_SUPERSESSION_MARKER = '<!-- buildd-refresh-superseded -->';
/** Look-back for refresh PRs, and the cap per run (the sweep shares a 60s cron). */
export const REFRESH_SWEEP_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
export const REFRESH_SWEEP_CAP = 25;

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<any>;

/** A refresh PR as the sweep sees it (one worker row plus its task's refresh context). */
export interface RefreshPr {
  workerId: string;
  taskId: string | null;
  workspaceId: string | null;
  missionId: string;
  repo: string;
  prNumber: number;
  refresh: IntegrationRefreshContext;
}

export type RefreshSupersessionVerdict =
  | { ok: true; branch: string; trunk: string; filesChecked: number; migrationsMatched: number; closedOnGitHub: boolean }
  | { ok: false; reason: string; transient: boolean };

const MIGRATION_SQL = /(^|\/)drizzle\/[^/]+\.sql$/;
const MIGRATION_META = /(^|\/)drizzle\/meta\//;

function toDiff(f: DeltaFile & { sha?: string | null }): DiffFile {
  return { filename: f.filename, status: f.status, sha: f.sha ?? null, patch: f.patch ?? null };
}

/**
 * Does `newer` (merged) fully replace `older` (open)? Reads only; changes nothing.
 * Fails closed: an unreadable or truncated answer is `ok: false`, `transient`
 * when asking again later could change it.
 */
export async function verifyRefreshSuperseded(opts: {
  installationId: number;
  older: RefreshPr;
  newer: RefreshPr;
  api?: Api;
}): Promise<RefreshSupersessionVerdict> {
  const api = opts.api ?? githubApi;
  const { installationId, older, newer } = opts;
  const repo = older.repo;
  const trunk = older.refresh.trunk;
  if (!trunk) return { ok: false, reason: 'the older refresh does not record which trunk it merged', transient: false };

  let o: any;
  let n: any;
  try {
    [o, n] = await Promise.all([
      api(installationId, `/repos/${repo}/pulls/${older.prNumber}`),
      api(installationId, `/repos/${repo}/pulls/${newer.prNumber}`),
    ]);
  } catch (err) {
    return { ok: false, reason: `could not read the PRs: ${err instanceof Error ? err.message : String(err)}`, transient: true };
  }
  if (o?.merged) return { ok: false, reason: 'the older PR is merged', transient: false };
  if (!n?.merged) return { ok: false, reason: 'the newer PR is not merged', transient: false };
  const branch: string | undefined = o?.base?.ref;
  if (!branch || n?.base?.ref !== branch) return { ok: false, reason: 'the PRs target different branches', transient: false };
  if (!branch.startsWith(MISSION_BRANCH_PREFIX)) return { ok: false, reason: `${branch} is not a mission integration branch`, transient: false };
  const olderHead: string | undefined = o?.head?.sha;
  if (!olderHead) return { ok: false, reason: 'the older PR has no head sha', transient: true };

  // (2) Ancestry: what the older refresh set out to do is already in the branch.
  const landed = await verifyRefreshLanded({
    installationId, repoFullName: repo, branch, trunk, refresh: older.refresh, prHeadSha: olderHead, api,
  });
  if (!landed.ok) return { ok: false, reason: landed.reason, transient: landed.transient };

  // (3) Independent work: everything the older PR adds on top of trunk must be in the branch.
  const [olderDelta, branchDelta] = await Promise.all([
    effectiveDeltaFiles(installationId, repo, trunk, olderHead, api),
    effectiveDeltaFiles(installationId, repo, trunk, landed.branchHead, api),
  ]);
  if (!olderDelta || !branchDelta) return { ok: false, reason: 'could not read a complete file list to compare', transient: true };

  const branchFiles = branchDelta.map(toDiff);
  const olderFiles = olderDelta.map(toDiff);
  const sql = olderFiles.filter(f => MIGRATION_SQL.test(f.filename) && f.status !== 'removed');
  const sqlTwins = sql.filter(f => f.sha && branchFiles.some(b => b.status !== 'removed' && b.sha === f.sha));
  if (sqlTwins.length !== sql.length) {
    const missing = sql.filter(f => !sqlTwins.includes(f)).map(f => f.filename);
    return { ok: false, reason: `migration not found in ${branch} with identical SQL: ${missing.join(', ')}`, transient: false };
  }
  const compared = olderFiles.filter(f => !MIGRATION_META.test(f.filename));
  const removedHere = compared.filter(f => f.status === 'removed' && branchFiles.some(b => b.filename === f.filename && b.status !== 'removed'));
  if (removedHere.length > 0) {
    return { ok: false, reason: `the older PR deletes ${removedHere[0].filename}, which ${branch} still has`, transient: false };
  }
  const content = verifyByContent(compared, branchFiles);
  if (content.files > 0 && (content.totalLines === 0 || content.matchedLines < content.totalLines)) {
    return {
      ok: false,
      reason: `${content.totalLines - content.matchedLines} of ${content.totalLines} added lines in the older PR are not in ${branch}`,
      transient: false,
    };
  }

  return {
    ok: true, branch, trunk,
    filesChecked: compared.length, migrationsMatched: sqlTwins.length,
    closedOnGitHub: o?.state !== 'open',
  };
}

export type RetireOutcome =
  | { outcome: 'retired'; prNumber: number; supersededBy: number; evidence: string }
  | { outcome: 'kept'; prNumber: number; reason: string };

function evidenceLine(v: Extract<RefreshSupersessionVerdict, { ok: true }>, newer: number): string {
  return `auto: replaced by merged refresh #${newer}; ancestry and ${v.filesChecked} file(s) verified against ${v.branch}`
    + (v.migrationsMatched ? `, ${v.migrationsMatched} regenerated migration(s) matched by SQL` : '');
}

/**
 * Verify, then retire one older refresh PR. Safe to repeat: every step skips what
 * is already done, and the verification is re-run each time rather than trusted.
 */
export async function retireSupersededRefreshPr(opts: {
  installationId: number;
  older: RefreshPr;
  newer: RefreshPr;
  api?: Api;
}): Promise<RetireOutcome> {
  const api = opts.api ?? githubApi;
  const { installationId, older, newer } = opts;
  const keep = (reason: string, transient = false): RetireOutcome => {
    if (!transient) {
      fireGateEvent({
        gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
        surface: 'cron pr-reconcile',
        outcome: 'deferred',
        reason: `older refresh PR kept open: ${reason}`,
        workspaceId: older.workspaceId, taskId: older.taskId, workerId: older.workerId,
        detail: { prNumber: older.prNumber, newerPrNumber: newer.prNumber, repo: older.repo, kind: 'refresh_superseded' },
        callerOrigin: 'system',
      });
    }
    return { outcome: 'kept', prNumber: older.prNumber, reason };
  };

  const verdict = await verifyRefreshSuperseded({ installationId, older, newer, api });
  if (!verdict.ok) return keep(verdict.reason, verdict.transient);

  const repo = older.repo;
  const evidence = evidenceLine(verdict, newer.prNumber);

  try {
    if (!verdict.closedOnGitHub) {
      await api(installationId, `/repos/${repo}/pulls/${older.prNumber}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }),
      });
    }
    const comments = await api(installationId, `/repos/${repo}/issues/${older.prNumber}/comments?per_page=100`).catch(() => []);
    const already = Array.isArray(comments) && comments.some((c: any) => typeof c?.body === 'string' && c.body.includes(REFRESH_SUPERSESSION_MARKER));
    if (!already) {
      await api(installationId, `/repos/${repo}/issues/${older.prNumber}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: `${REFRESH_SUPERSESSION_MARKER}\nClosed by buildd: #${newer.prNumber} refreshed \`${verdict.branch}\` from \`${verdict.trunk}\` and has landed. `
            + `This PR's trunk and mission commits are already in the branch's history, and every line it adds is present there `
            + `(${verdict.filesChecked} file(s) checked${verdict.migrationsMatched ? `; ${verdict.migrationsMatched} regenerated migration(s) matched by identical SQL` : ''}).`,
        }),
      });
    }
    const recorded = await recordPrSupersession({
      workerId: older.workerId,
      supersedingPrNumber: newer.prNumber,
      reason: evidence,
      recordedBy: REFRESH_SUPERSESSION_ACTOR,
    });
    // 409 = an edge (or a merge) is already there: a prior run finished the job.
    if (!recorded.ok && recorded.status !== 409) throw new Error(`record refused: ${recorded.error}`);
  } catch (err) {
    const reason = `retire failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[superseded-refresh-prs] #${older.prNumber}: ${reason}`);
    fireGateEvent({
      gate: GATE_SLUGS.RETRY_PR_SUPERSESSION,
      surface: 'cron pr-reconcile',
      outcome: 'stranded',
      reason: `superseded refresh PR left open or unrecorded: ${reason}`,
      workspaceId: older.workspaceId, taskId: older.taskId, workerId: older.workerId,
      detail: { prNumber: older.prNumber, newerPrNumber: newer.prNumber, repo, kind: 'refresh_superseded' },
      callerOrigin: 'system',
    });
    return { outcome: 'kept', prNumber: older.prNumber, reason };
  }

  fireGateEvent({
    gate: GATE_SLUGS.AUTO_PR_SUPERSESSION,
    surface: 'cron pr-reconcile',
    outcome: 'accepted',
    reason: 'older integration-refresh PR retired: a newer refresh landed and its content is verified in the branch',
    workspaceId: older.workspaceId, taskId: older.taskId, workerId: older.workerId,
    detail: {
      prNumber: older.prNumber, supersedingPrNumber: newer.prNumber, repo, branch: verdict.branch,
      filesChecked: verdict.filesChecked, migrationsMatched: verdict.migrationsMatched,
      recordedBy: REFRESH_SUPERSESSION_ACTOR, kind: 'refresh_superseded',
    },
    callerOrigin: 'system',
  });
  return { outcome: 'retired', prNumber: older.prNumber, supersededBy: newer.prNumber, evidence };
}

export interface RefreshSupersessionSweepResult {
  candidates: number;
  retired: number;
  kept: number;
  skipped: number;
}

/** Open (or closed-without-an-edge) and merged refresh PRs, from our own rows. */
async function loadRefreshPrs(now: Date): Promise<{ open: RefreshPr[]; merged: RefreshPr[] }> {
  const rows = await db
    .select({
      workerId: workers.id, taskId: workers.taskId, workspaceId: workers.workspaceId, prUrl: workers.prUrl,
      prNumber: workers.prNumber, mergedAt: workers.mergedAt, lifecycle: workers.prLifecycleStatus,
      supersededBy: workers.supersededByPrNumber, abandonedAt: workers.abandonedAt,
      missionId: tasks.missionId, context: tasks.context,
    })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      isNotNull(tasks.missionId),
      isNotNull(workers.prNumber),
      isNotNull(workers.prUrl),
      gte(workers.updatedAt, new Date(now.getTime() - REFRESH_SWEEP_WINDOW_MS)),
    ))
    .orderBy(desc(workers.prNumber))
    .limit(REFRESH_SWEEP_CAP * 8);

  const open: RefreshPr[] = [];
  const merged: RefreshPr[] = [];
  for (const r of rows) {
    const refresh = integrationRefreshOf(r.context);
    const repo = repoFullNameFromPrUrl(r.prUrl);
    if (!refresh || !repo || !r.missionId || typeof r.prNumber !== 'number') continue;
    const pr: RefreshPr = { workerId: r.workerId, taskId: r.taskId, workspaceId: r.workspaceId, missionId: r.missionId, repo, prNumber: r.prNumber, refresh };
    if (r.mergedAt) merged.push(pr);
    else if (r.supersededBy == null && !r.abandonedAt && r.lifecycle !== 'unresolvable') open.push(pr);
  }
  return { open, merged };
}

/**
 * The hourly step. For each unmerged refresh PR, find a merged refresh PR in the
 * same mission and repo with a higher number and try to retire it. One older PR
 * is never tried against more than the newest few successors.
 */
export async function sweepSupersededRefreshPrs(
  now: Date = new Date(),
  deps: { load?: typeof loadRefreshPrs; installation?: (repo: string) => Promise<number | null>; api?: Api } = {},
): Promise<RefreshSupersessionSweepResult> {
  const result: RefreshSupersessionSweepResult = { candidates: 0, retired: 0, kept: 0, skipped: 0 };
  const { open, merged } = await (deps.load ?? loadRefreshPrs)(now);
  const installation = deps.installation ?? ((repo: string) => installationIdForRepo(repo).catch(() => null));
  const cache = new Map<string, number | null>();

  for (const older of open.slice(0, REFRESH_SWEEP_CAP)) {
    const successors = merged
      .filter(m => m.missionId === older.missionId && m.repo.toLowerCase() === older.repo.toLowerCase() && m.prNumber > older.prNumber)
      .sort((a, b) => b.prNumber - a.prNumber)
      .slice(0, 3);
    if (successors.length === 0) continue;
    result.candidates++;

    const key = older.repo.toLowerCase();
    if (!cache.has(key)) cache.set(key, await installation(older.repo));
    const installationId = cache.get(key);
    if (!installationId) { result.skipped++; continue; }

    let done = false;
    for (const newer of successors) {
      const out = await retireSupersededRefreshPr({ installationId, older, newer, api: deps.api }).catch((err): RetireOutcome => {
        console.error(`[superseded-refresh-prs] sweep failed for #${older.prNumber}:`, err);
        return { outcome: 'kept', prNumber: older.prNumber, reason: 'error' };
      });
      if (out.outcome === 'retired') { result.retired++; done = true; break; }
    }
    if (!done) result.kept++;
  }
  return result;
}
