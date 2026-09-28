/**
 * PRs buildd opened or adopted, as a list for "what needs me", "what's open",
 * "what's conflicting", "what's red" and "what shipped" (GET /api/prs, the
 * `list_prs` MCP action and chat tool).
 *
 * Closed-unmerged PRs are never listed: they outnumber the open ones many
 * times over and a list of abandoned attempts answers no question anyone
 * asks. One PR is read with get_pr.
 *
 * Several workers can share a PR (retries, reviewer passes), and an older
 * row may still say ci_failed after a newer one merged. So rows are collapsed
 * per PR before any filtering: any merged row means merged, any closed row
 * means closed, otherwise the most recently checked row says the state.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { PrListState as SharedPrListState } from '@buildd/shared';
import { isMissionIntegrationBase } from '@buildd/core/mission-integration';
import { loadPrAttention } from '@/lib/pr-attention';

export const PR_LIST_STATES = ['open', 'attention', 'conflict', 'ci_failed', 'merged'] as const satisfies readonly SharedPrListState[];
export type PrListState = (typeof PR_LIST_STATES)[number];

type Lifecycle = NonNullable<typeof workers.$inferSelect.prLifecycleStatus>;
const TERMINAL: Lifecycle[] = ['merged', 'closed', 'unresolvable'];

export const DEFAULT_MERGED_WINDOW_DAYS = 7;
export const MAX_PR_LIST = 50;

export function parsePrListState(raw: string | null | undefined): { state: PrListState } | { error: string } {
  if (!raw) return { state: 'open' };
  if ((PR_LIST_STATES as readonly string[]).includes(raw)) return { state: raw as PrListState };
  if (raw === 'closed') return { error: 'Closed PRs are not listed. Read one with get_pr (prNumber).' };
  return { error: `state must be one of ${PR_LIST_STATES.join(', ')}` };
}

/**
 * Rows that may belong in the list: in the caller's workspaces, with a PR,
 * and (by state) not yet merged or merged in the window. The final word on
 * each PR comes from shapePrRows, over all of that PR's rows.
 */
export function buildPrListWhere(opts: { workspaceIds: string[]; state: PrListState; since?: Date }): SQL {
  const base = [inArray(workers.workspaceId, opts.workspaceIds), isNotNull(workers.prUrl)];
  if (opts.state === 'merged') {
    base.push(isNotNull(workers.mergedAt), gte(workers.mergedAt, opts.since ?? new Date(0)));
  } else {
    base.push(isNull(workers.mergedAt));
    // attention also means "waiting on you", decided after the query (needsAttention).
    if (opts.state === 'open' || opts.state === 'attention') {
      base.push(or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL))!);
    } else {
      base.push(eq(workers.prLifecycleStatus, opts.state));
    }
  }
  return and(...base)!;
}

export interface PrListRow {
  workerId: string;
  prNumber: number | null;
  prUrl: string;
  status: string | null;
  mergedAt: Date | null;
  lastCheckedAt: Date | null;
  conflictDetectedAt: Date | null;
  startedAt: Date | null;
  workspaceId: string;
  workspaceName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  missionId: string | null;
  missionTitle: string | null;
  baseRef: string | null;
  missionWorkingBranch: string | null;
  missionIntegration: boolean | null;
}

/** A collapsed PR: the row that speaks for it, plus every worker id that shares it. */
export type ShapedPr = PrListRow & { workerIds: string[] };

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
const RANK: Record<string, number> = { conflict: 0, ci_failed: 1 };

/** One row per PR, filtered to `state` and sorted: see the module comment. */
export function shapePrRows(rows: PrListRow[], state: PrListState): ShapedPr[] {
  const byPr = new Map<string, PrListRow[]>();
  for (const r of rows) byPr.set(r.prUrl, [...(byPr.get(r.prUrl) ?? []), r]);

  const out: ShapedPr[] = [];
  for (const group of byPr.values()) {
    const workerIds = group.map(r => r.workerId);
    const merged = group.filter(r => r.mergedAt || r.status === 'merged').sort((a, b) => time(b.mergedAt) - time(a.mergedAt))[0];
    if (merged) {
      if (state === 'merged') out.push({ ...merged, status: 'merged', workerIds });
      continue;
    }
    if (state === 'merged' || group.some(r => r.status === 'closed' || r.status === 'unresolvable')) continue;
    const latest = [...group].sort((a, b) => (time(b.lastCheckedAt) - time(a.lastCheckedAt)) || (time(b.startedAt) - time(a.startedAt)))[0];
    const status = latest.status;
    const keep = state === 'open' || state === 'attention' || status === state;
    if (keep) out.push({ ...latest, workerIds });
  }

  if (state === 'merged') return out.sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
  return out.sort((a, b) => ((RANK[a.status ?? ''] ?? 2) - (RANK[b.status ?? ''] ?? 2)) || (time(b.startedAt) - time(a.startedAt)));
}

/** What the list says beyond the state, and only when it matters (quiet PRs carry none). */
export interface PrSignals {
  /** Why a person is needed: the escalation inbox's decision. */
  waitingOnYou?: string;
  /** An agent is already on it. */
  resolving?: 'conflict' | 'ci' | 'review';
  /** CI fix tasks buildd has dispatched for this PR (red only): the retries give up after a few. */
  ciFixAttempts?: number;
  /** Targets a mission integration branch: merging integrates, it doesn't ship. */
  intoMissionBranch?: string;
  /** State last read from GitHub this long ago (over an hour; the webhook is lossy). */
  checkedHoursAgo?: number;
}

export interface PrAttentionIndex {
  /** workerId → why it is waiting on a person. */
  inbox: Map<string, string>;
  /** workerIds under a live agent-review lease. */
  reviewing: Set<string>;
  /** `${workspaceId}:${prNumber}` with a live conflict-fix task. */
  conflictFix: Set<string>;
  /** `${workspaceId}:${prNumber}` with a live CI-fix task. */
  ciFix: Set<string>;
  /** `${workspaceId}:${prNumber}` → CI-fix tasks dispatched so far, any status. */
  ciFixAttempts: Map<string, number>;
}

const STALE_MS = 60 * 60 * 1000;

export function prSignals(pr: ShapedPr, a: PrAttentionIndex, now: Date = new Date()): PrSignals {
  const out: PrSignals = {};
  const waiting = pr.workerIds.map(id => a.inbox.get(id)).find(Boolean);
  const key = `${pr.workspaceId}:${pr.prNumber}`;
  const resolving = a.conflictFix.has(key) ? 'conflict'
    : a.ciFix.has(key) ? 'ci'
    : pr.workerIds.some(id => a.reviewing.has(id)) ? 'review'
    : undefined;
  // An agent resolving it outranks the inbox's "resolving" card: it isn't yours yet.
  if (resolving) out.resolving = resolving;
  else if (waiting) out.waitingOnYou = waiting;
  // Not workers.prCheckFailureCount: that counts failed GitHub lookups and resets on success.
  const attempts = a.ciFixAttempts.get(key) ?? 0;
  if (pr.status === 'ci_failed' && attempts > 0) out.ciFixAttempts = attempts;
  if (pr.baseRef && isMissionIntegrationBase({
    baseRef: pr.baseRef,
    mission: pr.missionWorkingBranch ? { workingBranch: pr.missionWorkingBranch, integrationBranchEnabled: pr.missionIntegration } : null,
  })) out.intoMissionBranch = pr.baseRef;
  if (pr.status !== 'merged' && pr.lastCheckedAt) {
    const age = now.getTime() - new Date(pr.lastCheckedAt).getTime();
    if (age > STALE_MS) out.checkedHoursAgo = Math.floor(age / STALE_MS);
  }
  return out;
}

/** The attention index for these PRs: the inbox decision, plus live fix and review tasks. */
async function loadAttentionIndex(prs: ShapedPr[], workspaceIds: string[]): Promise<PrAttentionIndex> {
  const idx: PrAttentionIndex = { inbox: new Map(), reviewing: new Set(), conflictFix: new Set(), ciFix: new Set(), ciFixAttempts: new Map() };
  if (prs.length === 0) return idx;
  const attention = await loadPrAttention(workspaceIds, { workerIds: prs.flatMap(p => p.workerIds) });
  for (const w of attention.openPrWorkers) {
    if (w.taskId && attention.agentReviewingTaskIds.has(w.taskId)) idx.reviewing.add(w.id);
    const key = `${w.workspaceId}:${w.prNumber}`;
    if (attention.conflictRetryMap.has(key)) idx.conflictFix.add(key);
    if (!attention.isInInbox(w) || attention.conflictRetryMap.has(key)) continue;
    idx.inbox.set(w.id, attention.deadZoneExhaustedMap.has(w.id) ? 'conflict fixes used up'
      : w.taskId && attention.escalationMap.has(w.taskId) ? 'reviewer escalated'
      : w.taskId && attention.approvalMap.has(w.taskId) ? 'approved, merge is yours'
      : 'human merge');
  }
  const prNumbers = [...new Set(prs.map(p => p.prNumber).filter((n): n is number => n != null))];
  if (prNumbers.length > 0) {
    const ciFixes = await db.select({ workspaceId: tasks.workspaceId, prNumber: tasks.ciRetryPrNumber, status: tasks.status }).from(tasks).where(and(
      inArray(tasks.workspaceId, workspaceIds),
      inArray(tasks.ciRetryPrNumber, prNumbers),
    ));
    for (const t of ciFixes) {
      const key = `${t.workspaceId}:${t.prNumber}`;
      idx.ciFixAttempts.set(key, (idx.ciFixAttempts.get(key) ?? 0) + 1);
      if (['pending', 'assigned', 'in_progress'].includes(t.status)) idx.ciFix.add(key);
    }
  }
  return idx;
}

export type PrListItemRow = Omit<ShapedPr, 'workerIds' | 'missionWorkingBranch' | 'missionIntegration'> & PrSignals;

export async function listPrsQuery(opts: { workspaceIds: string[]; state: PrListState; since?: Date; limit?: number }): Promise<PrListItemRow[]> {
  if (opts.workspaceIds.length === 0) return [];
  // Every row of each candidate PR, so the collapse sees a newer merged or
  // closed row even when only an older row matched the candidate filter.
  const candidates = db.selectDistinct({ prUrl: workers.prUrl }).from(workers).where(buildPrListWhere(opts));
  const rows = await db
    .select({
      workerId: workers.id,
      prNumber: workers.prNumber,
      prUrl: sql<string>`${workers.prUrl}`,
      status: workers.prLifecycleStatus,
      mergedAt: workers.mergedAt,
      lastCheckedAt: workers.prLastCheckedAt,
      conflictDetectedAt: workers.conflictDetectedAt,
      startedAt: workers.startedAt,
      workspaceId: workers.workspaceId,
      workspaceName: workspaces.name,
      taskId: workers.taskId,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      baseRef: workers.prBaseRef,
      missionWorkingBranch: missions.workingBranch,
      missionIntegration: missions.integrationBranchEnabled,
    })
    .from(workers)
    .leftJoin(workspaces, eq(workspaces.id, workers.workspaceId))
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .leftJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(inArray(workers.workspaceId, opts.workspaceIds), inArray(workers.prUrl, candidates)))
    .orderBy(desc(workers.startedAt))
    .limit(1000);
  const limit = Math.min(opts.limit ?? 20, MAX_PR_LIST);
  const shaped = shapePrRows(rows as PrListRow[], opts.state);
  // attention filters on the signals, so it reads them for every open PR first.
  const prs = opts.state === 'attention' ? shaped : shaped.slice(0, limit);
  const attention = opts.state === 'merged' ? null : await loadAttentionIndex(prs, opts.workspaceIds);
  const now = new Date();
  const out: PrListItemRow[] = prs.map(({ workerIds, missionWorkingBranch, missionIntegration, ...pr }) => ({
    ...pr,
    ...(attention ? prSignals({ ...pr, workerIds, missionWorkingBranch, missionIntegration }, attention, now) : {}),
  }));
  if (opts.state === 'merged') return out;
  const ranked = rankPrs(out);
  return opts.state === 'attention' ? ranked.filter(needsAttention).slice(0, limit) : ranked;
}

/**
 * What to look at first: a PR waiting on you (you can act now), then red PRs
 * nobody is fixing, then ones an agent is fixing, then the rest. Stable, so
 * shapePrRows' recency order holds within each rank.
 */
export function rankPrs<T extends { status: string | null; waitingOnYou?: string; resolving?: string }>(prs: T[]): T[] {
  const rank = (p: T) => p.waitingOnYou ? 0
    : (p.status === 'conflict' || p.status === 'ci_failed') ? (p.resolving ? 2 : 1)
    : 3;
  return prs.map((p, i) => ({ p, i })).sort((a, b) => (rank(a.p) - rank(b.p)) || (a.i - b.i)).map(x => x.p);
}

/** attention: a conflict, red CI, or a PR waiting on a person. */
export function needsAttention(pr: { status: string | null; waitingOnYou?: string }): boolean {
  return pr.status === 'conflict' || pr.status === 'ci_failed' || !!pr.waitingOnYou;
}
