/**
 * Reads and writes behind the review-by-risk release summary (spec 62e985a8
 * R-6, R-7); the rules are ./summary.ts.
 *
 * An approval is a `release_flow_steps` row (step `approve_summary`, the
 * person, the commit): the append-only record of who pressed which release
 * button, so no new table. It covers exactly that commit.
 *
 * `guardReleaseSummary` is the one check every release entry point asks
 * before anything ships: the dispatch (`recordAndDispatchRelease`, behind the
 * trigger route, the every-merge and mission-complete subscribers and the
 * compose flow), `executeRelease` (branch_merge and script), and the release
 * PR's promotion on CI green. It reads nothing beyond the workspace row when
 * review by risk is off, and with the workspace unreadable it passes (the mode
 * cannot be shown on); once the mode is known on it fails closed.
 */

import { db as defaultDb } from '@buildd/core/db';
import { gateEvents, releaseFlowSteps, releases, specs, tasks, users, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import type { WorkspaceGitConfig, WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { extractLede } from '@buildd/core/pr-lede';
import { reviewByRiskOf, type ReviewByRiskArea } from '@buildd/shared';
import { effectiveStrategy } from '@buildd/core/release-strategy';
import { githubApi as defaultGithubApi } from '@/lib/github';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { isGeneratedMigrationPath } from '@/lib/migration-safety';
import { pathMatches } from '@/lib/review-by-risk';
import { firstParentPrs, type CompareCommit } from './compose-source';
import {
  buildReleaseSummary,
  decideReleaseApproval,
  releaseEnds,
  summaryApprovalRequired,
  type ReleaseEnds,
  type ReleaseSummary,
  type ReleaseSummaryItem,
} from './summary';

export const APPROVE_SUMMARY_STEP = 'approve_summary' as const;
/** PRs listed in one summary; a release with more names the rest as a count. */
export const MAX_SUMMARY_PRS = 50;

export interface SummaryDeps {
  db?: typeof defaultDb;
  githubApi?: typeof defaultGithubApi;
}

interface WorkspaceRelease {
  gitConfig: WorkspaceGitConfig | null;
  releaseConfig: WorkspaceReleaseConfig | null;
  installationId: number | null;
  repoFullName: string | null;
  defaultBranch: string | null;
}

async function loadWorkspaceRelease(workspaceId: string, db: typeof defaultDb): Promise<WorkspaceRelease | null> {
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, gitConfig: true, releaseConfig: true },
    with: { githubRepo: { columns: { fullName: true, defaultBranch: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  if (!ws) return null;
  const repo = (ws as { githubRepo?: { fullName?: string | null; defaultBranch?: string | null; installation?: { installationId?: number | null } | null } | null }).githubRepo;
  return {
    gitConfig: (ws.gitConfig ?? null) as WorkspaceGitConfig | null,
    releaseConfig: (ws.releaseConfig ?? null) as WorkspaceReleaseConfig | null,
    installationId: repo?.installation?.installationId ?? null,
    repoFullName: repo?.fullName ?? null,
    defaultBranch: repo?.defaultBranch ?? null,
  };
}

async function approvedShas(workspaceId: string, db: typeof defaultDb): Promise<string[]> {
  const rows = await db.select({ sha: releaseFlowSteps.candidateSha }).from(releaseFlowSteps)
    .where(and(eq(releaseFlowSteps.workspaceId, workspaceId), eq(releaseFlowSteps.step, APPROVE_SUMMARY_STEP), eq(releaseFlowSteps.outcome, 'succeeded')));
  return rows.map((r) => r.sha).filter((s): s is string => !!s);
}

export function releaseSummaryHref(workspaceId: string): string {
  return `/app/settings/workspace/${workspaceId}#release-summary`;
}

export type ReleaseSummaryGate =
  | { blocks: false }
  | { blocks: true; reason: string; clearedBy: string };

/**
 * Does a release of `headSha` wait for a summary approval? Every release
 * entry point calls this (see the module doc), so none carries its own copy.
 */
export async function guardReleaseSummary(
  params: {
    workspaceId: string;
    headSha: string;
    surface: string;
    /**
     * Which act ships: `dispatch` (a workflow or script release starts) or
     * `merge` (a release PR, or a worker PR, merges into the prod branch). A
     * release is gated once, where its strategy ships it: `branch_merge` at
     * the merge, `workflow_dispatch` and `script` at the dispatch (the
     * candidate PR the workflow opens is downstream of that approval).
     */
    door: 'dispatch' | 'merge';
  },
  deps: SummaryDeps = {},
): Promise<ReleaseSummaryGate> {
  const db = deps.db ?? defaultDb;
  let ws: WorkspaceRelease | null;
  try {
    ws = await loadWorkspaceRelease(params.workspaceId, db);
  } catch (err) {
    console.warn(`[release-summary] could not read workspace ${params.workspaceId}; summary approval not applied:`, err);
    return { blocks: false };
  }
  if (!ws || !summaryApprovalRequired(ws.gitConfig, ws.releaseConfig)) return { blocks: false };
  const shipsAtMerge = effectiveStrategy(ws.releaseConfig!) === 'branch_merge';
  if ((params.door === 'merge') !== shipsAtMerge) return { blocks: false };
  const ends = releaseEnds(ws.releaseConfig, ws.gitConfig, ws.defaultBranch);
  let approved: string[];
  try {
    approved = await approvedShas(params.workspaceId, db);
  } catch (err) {
    approved = [];
    console.warn(`[release-summary] could not read approvals for ${params.workspaceId}; refusing:`, err);
  }
  const decision = decideReleaseApproval({ required: true, headSha: params.headSha, approvedShas: approved, source: ends?.source ?? null });
  if (!decision.blocks) return decision;
  const clearedBy = `A person approves the release summary for this commit (${releaseSummaryHref(params.workspaceId)}); the release then ships that commit.`;
  fireGateEvent({
    gate: GATE_SLUGS.REVIEW_BY_RISK,
    surface: params.surface,
    outcome: 'deferred',
    reason: decision.reason,
    workspaceId: params.workspaceId,
    callerOrigin: 'system',
    detail: { kind: 'release_summary', headSha: params.headSha, source: ends?.source ?? null, target: ends?.target ?? null },
  });
  return { blocks: true, reason: decision.reason, clearedBy };
}

type Gh = (installationId: number, path: string) => Promise<any>;

async function refHead(gh: Gh, installationId: number, repo: string, branch: string): Promise<string | null> {
  const ref = await gh(installationId, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  return typeof ref?.object?.sha === 'string' ? ref.object.sha : null;
}

export type LoadSummaryResult =
  | { ok: true; required: boolean; approved: boolean; summary: ReleaseSummary; omitted: number }
  | { ok: false; status: number; error: string };

/** The release summary for the source branch's head now (R-7). */
export async function loadReleaseSummary(workspaceId: string, deps: SummaryDeps = {}): Promise<LoadSummaryResult> {
  const db = deps.db ?? defaultDb;
  const gh: Gh = deps.githubApi ?? defaultGithubApi;
  const ws = await loadWorkspaceRelease(workspaceId, db);
  if (!ws) return { ok: false, status: 404, error: 'Workspace not found' };
  const ends = releaseEnds(ws.releaseConfig, ws.gitConfig, ws.defaultBranch);
  if (!ends) return { ok: false, status: 409, error: 'This workspace has no release step, so there is no release summary.' };
  if (!ws.installationId || !ws.repoFullName) return { ok: false, status: 409, error: 'This workspace has no GitHub repo connected.' };
  const head = await refHead(gh, ws.installationId, ws.repoFullName, ends.source).catch(() => null);
  if (!head) return { ok: false, status: 502, error: `Could not read the head of ${ends.source}.` };

  const base = await summaryBase(ends, workspaceId, db);
  let commits: CompareCommit[] = [];
  if (base) {
    const cmp = await gh(ws.installationId, `/repos/${ws.repoFullName}/compare/${encodeURIComponent(base)}...${head}?per_page=250`).catch(() => null);
    commits = Array.isArray(cmp?.commits) ? cmp.commits : [];
  }
  const prs = firstParentPrs(commits, head);
  const listed = prs.slice(0, MAX_SUMMARY_PRS);
  const items = await summaryItems(workspaceId, listed, ws, gh, db);
  const required = summaryApprovalRequired(ws.gitConfig, ws.releaseConfig);
  const approved = (await approvedShas(workspaceId, db)).some((s) => s.toLowerCase() === head.toLowerCase());
  return { ok: true, required, approved, summary: buildReleaseSummary({ headSha: head, ends, items }), omitted: prs.length - listed.length };
}

/** Where "since the last release" starts: the target branch when the config names one, else the last recorded release. */
async function summaryBase(ends: ReleaseEnds, workspaceId: string, db: typeof defaultDb): Promise<string | null> {
  if (ends.targetBranch && ends.targetBranch !== ends.source) return ends.targetBranch;
  const [last] = await db.select({ headSha: releases.headSha }).from(releases)
    .where(eq(releases.workspaceId, workspaceId)).orderBy(desc(releases.createdAt)).limit(1);
  return last?.headSha ?? null;
}

async function summaryItems(
  workspaceId: string,
  prs: ReadonlyArray<{ number: number; title: string }>,
  ws: WorkspaceRelease,
  gh: Gh,
  db: typeof defaultDb,
): Promise<ReleaseSummaryItem[]> {
  if (!prs.length) return [];
  const numbers = prs.map((p) => p.number);
  const workerRows = await db.select({ prNumber: workers.prNumber, taskId: workers.taskId }).from(workers)
    .where(and(eq(workers.workspaceId, workspaceId), inArray(workers.prNumber, numbers)));
  const taskIds = [...new Set(workerRows.map((w) => w.taskId).filter((t): t is string => !!t))];
  const taskRows = taskIds.length ? await db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(inArray(tasks.id, taskIds)) : [];
  const pinOf = (taskId: string | null | undefined) => {
    const ctx = taskRows.find((t) => t.id === taskId)?.context as { specSource?: Record<string, unknown> } | null | undefined;
    const pin = ctx?.specSource;
    return pin && typeof pin.specId === 'string' ? pin : null;
  };
  const specIds = [...new Set(workerRows.map((w) => pinOf(w.taskId)?.specId as string | undefined).filter((s): s is string => !!s))];
  const specRows = specIds.length ? await db.select({ id: specs.id, title: specs.title }).from(specs).where(inArray(specs.id, specIds)) : [];

  // R-4 approvals: a person's merge past a risk area, recorded by the merge rail.
  const approvals = await db.select({ detail: gateEvents.detail }).from(gateEvents)
    .where(and(eq(gateEvents.workspaceId, workspaceId), eq(gateEvents.gate, GATE_SLUGS.REVIEW_BY_RISK), eq(gateEvents.outcome, 'bypassed')))
    .orderBy(desc(gateEvents.occurredAt)).limit(500);
  const approverIds = [...new Set(approvals.map((a) => (a.detail as { approvedBy?: unknown } | null)?.approvedBy).filter((v): v is string => typeof v === 'string'))];
  const userRows = approverIds.length ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, approverIds)).catch(() => []) : [];
  const nameOf = (id: string | null) => (id ? userRows.find((u) => u.id === id)?.email ?? id : null);

  const policy = reviewByRiskOf(ws.gitConfig?.mergePolicy);
  const migrationPaths = policy?.areas?.dataMigrations ?? [];

  const items: ReleaseSummaryItem[] = [];
  for (const pr of prs) {
    const taskId = workerRows.find((w) => w.prNumber === pr.number)?.taskId ?? null;
    const pin = pinOf(taskId);
    const [prData, files] = await Promise.all([
      gh(ws.installationId!, `/repos/${ws.repoFullName}/pulls/${pr.number}`).catch(() => null),
      gh(ws.installationId!, `/repos/${ws.repoFullName}/pulls/${pr.number}/files?per_page=300`).catch(() => null),
    ]);
    const areaRows = approvals
      .map((a) => a.detail as { prNumber?: unknown; approvedBy?: unknown; areas?: Array<{ area?: unknown }> } | null)
      .filter((d) => d?.prNumber === pr.number);
    const areas: ReleaseSummaryItem['areas'] = [];
    for (const d of areaRows) {
      for (const a of d?.areas ?? []) {
        const area = a?.area as ReviewByRiskArea;
        if (typeof area === 'string' && !areas.some((x) => x.area === area)) {
          areas.push({ area, approvedBy: nameOf(typeof d?.approvedBy === 'string' ? d.approvedBy : null) });
        }
      }
    }
    const fileNames: string[] = Array.isArray(files) ? files.map((f: { filename?: unknown }) => String(f.filename ?? '')) : [];
    const migrations = fileNames.filter((f) => isGeneratedMigrationPath(f) || migrationPaths.some((p) => pathMatches(p, f)));
    items.push({
      prNumber: pr.number,
      title: typeof prData?.title === 'string' ? prData.title : pr.title,
      lede: extractLede(prData?.body)?.lede ?? (typeof prData?.title === 'string' ? prData.title : pr.title),
      areas,
      spec: pin
        ? {
            specId: pin.specId as string,
            title: specRows.find((s) => s.id === pin.specId)?.title ?? null,
            revision: typeof pin.revision === 'number' ? pin.revision : null,
            criteria: Array.isArray(pin.criteria) ? (pin.criteria as unknown[]).filter((c): c is string => typeof c === 'string') : [],
          }
        : null,
      builtAhead: pin?.provisional === true,
      migrations,
    });
  }
  return items;
}

export type ApproveSummaryResult =
  | { ok: true; headSha: string }
  | { ok: false; status: number; error: string };

/**
 * A person approves the summary for `headSha`. Refused when the source head
 * has moved on: a newer head needs its own summary (R-6). Callers check the
 * caller is a person; this records who.
 */
export async function approveReleaseSummary(
  params: { workspaceId: string; userId: string; headSha: string },
  deps: SummaryDeps = {},
): Promise<ApproveSummaryResult> {
  const db = deps.db ?? defaultDb;
  const gh: Gh = deps.githubApi ?? defaultGithubApi;
  const ws = await loadWorkspaceRelease(params.workspaceId, db);
  if (!ws) return { ok: false, status: 404, error: 'Workspace not found' };
  if (!summaryApprovalRequired(ws.gitConfig, ws.releaseConfig)) {
    return { ok: false, status: 409, error: 'This workspace does not ask for a release summary approval (review by risk off, no release step, or summary approval turned off).' };
  }
  const ends = releaseEnds(ws.releaseConfig, ws.gitConfig, ws.defaultBranch);
  if (!ends || !ws.installationId || !ws.repoFullName) return { ok: false, status: 409, error: 'This workspace has no release source to approve.' };
  const head = await refHead(gh, ws.installationId, ws.repoFullName, ends.source).catch(() => null);
  if (!head) return { ok: false, status: 502, error: `Could not read the head of ${ends.source}.` };
  if (head.toLowerCase() !== params.headSha.trim().toLowerCase()) {
    return { ok: false, status: 409, error: `${ends.source} has moved to ${head.slice(0, 7)} since this summary was made; review the new summary and approve that one.` };
  }
  await db.insert(releaseFlowSteps).values({
    workspaceId: params.workspaceId,
    actorUserId: params.userId,
    step: APPROVE_SUMMARY_STEP,
    outcome: 'succeeded',
    candidateSha: head,
    detail: { source: ends.source, target: ends.target, strategy: ends.strategy },
  });
  return { ok: true, headSha: head };
}
