import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { and, count, inArray, sql, type SQL } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { appBaseUrl } from '@/lib/app-url';
import { roleHas } from '@/lib/permissions';
import { requestingPerson } from '@/lib/request-person';
import { classifyRisk, sortHighFirst, type RiskTier } from '@buildd/spec-contract/risk-tier';
import { getArtifactRevisions } from '@/lib/artifact-revisions';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * Awaiting your approval (Living Spec b7fc9316, R-1, R-7, R-9, R-10): the
 * spec revisions that wait on a person, gathered in one place.
 *
 * Waiting means: the spec is live (not retired or superseded), its head is
 * newer than its approved revision or nothing is approved yet, and it is not
 * an import waiting for confirm_import (that has its own confirm list). Who it
 * waits on is who may approve it (approval.ts specApprover): an owner or admin
 * of the workspace's team, or a member the workspace names as a delegated
 * approver. Everything here is read from the person's own id; no request
 * parameter adds, removes or reorders a row.
 *
 * Nothing here approves. The inbox page shows each row through the confirm
 * view (approval-view.ts) and approves one row at a time through
 * approveFromInbox (approval.ts), from a dashboard session only.
 */

/** The inbox page. */
export const SPEC_APPROVAL_INBOX_PATH = '/app/specs/approvals';
/** Every waiting revision on one page, with one Approve all (R-24). */
export const SPEC_REVIEW_ALL_PATH = '/app/specs/review-all';
export const specApprovalInboxUrl = () => `${appBaseUrl()}${SPEC_APPROVAL_INBOX_PATH}`;
export const specPageUrl = (specId: string) => `${appBaseUrl()}/app/specs/${encodeURIComponent(specId)}`;

/** A specs row that waits on a decision: live, a head newer than what is approved, not an unconfirmed import. */
export const awaitingApprovalWhere = () => sql`${specs.status} NOT IN ('retired', 'superseded')
  AND (${specs.approvedRevision} IS NULL OR ${specs.headRevision} > ${specs.approvedRevision})
  AND coalesce(${specs.repoSource}->>'state', '') <> 'imported'`;

/**
 * Waiting specs per workspace, as an un-run query (Home reads it in its first
 * round, lib/read-round.ts). Filter the workspaces by mayApproveIn after.
 */
export const awaitingApprovalCounts = (workspaceIds: readonly string[]) =>
  db.select({ workspaceId: specs.workspaceId, n: count() }).from(specs)
    .where(and(inArray(specs.workspaceId, [...workspaceIds]), awaitingApprovalWhere()))
    .groupBy(specs.workspaceId);

const rowsOf = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? []);

/** The approver list a workspace names, as stored in git_config.livingSpecs.approverUserIds. */
const delegates = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Whether a team member may approve specs in a workspace (approval.ts
 * specApprover's rule, from facts already read): their role holds
 * approve_specs, or the workspace names them as a delegated approver.
 */
export function mayApproveIn(role: string | null | undefined, gitConfig: unknown, userId: string): boolean {
  if (roleHas(role, 'approve_specs')) return true;
  if (!role) return false;
  return delegates((gitConfig as { livingSpecs?: { approverUserIds?: unknown } } | null)?.livingSpecs?.approverUserIds).includes(userId);
}

/** The workspaces this person may approve specs in, with their names. */
export async function approverWorkspaces(userId: string): Promise<Array<{ id: string; name: string }>> {
  if (!isUuid(userId)) return [];
  const rows = rowsOf<{ id: string; name: string; role: string; approvers: unknown }>(await db.execute(sql`
    SELECT w.id, w.name, tm.role, w.git_config->'livingSpecs'->'approverUserIds' AS approvers
    FROM workspaces w JOIN team_members tm ON tm.team_id = w.team_id AND tm.user_id = ${userId}::uuid`));
  return rows.filter((w) => mayApproveIn(w.role, { livingSpecs: { approverUserIds: w.approvers } }, userId)).map(({ id, name }) => ({ id, name }));
}

/** One spec whose head waits on a person. */
export interface AwaitingApprovalRow {
  specId: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  headRevision: number;
  approvedRevision: number | null;
  /** The spec version and the head's content hash, as read: what an Approve on this row is pinned to. */
  version: number;
  contentHash: string;
  /** Who wrote the head: a person's name, or "an agent". */
  author: string;
  changeSummary: string | null;
  /** The one-line summary of the head's explanation (R-15); null when none was written. */
  explanationSummary: string | null;
  proposedAt: string;
  /** High, Medium or Low, mechanically (R-32); the inbox sorts High first. */
  tier: RiskTier;
  /** Why, one plain line each. */
  tierReasons: string[];
}

/** Every spec this person may approve whose head waits on a decision: High first (R-33), newest proposal first within a tier. */
export async function listAwaitingApproval(userId: string): Promise<AwaitingApprovalRow[]> {
  const ws = await approverWorkspaces(userId);
  if (!ws.length) return [];
  const names = new Map(ws.map((w) => [w.id, w.name]));

  const rows = rowsOf<{
    id: string; title: string; workspace_id: string; head_revision: number; approved_revision: number | null; version: number;
    content_hash: string; scope: string; risk: string | null; body_artifact_id: string; head_artifact_revision: number; approved_artifact_revision: number | null; approved_content_hash: string | null; author_kind: string; author_name: string | null; change_summary: string | null; explanation_summary: string | null; created_at: string | Date;
  }>(await db.execute(sql`
    SELECT specs.id, specs.title, specs.workspace_id, specs.head_revision, specs.approved_revision, specs.version,
      r.content_hash, specs.scope, specs.metadata->>'risk' AS risk, specs.body_artifact_id, r.artifact_revision AS head_artifact_revision, ra.artifact_revision AS approved_artifact_revision, ra.content_hash AS approved_content_hash, r.author_kind, coalesce(nullif(trim(u.name), ''), u.email) AS author_name, r.change_summary, r.explanation->>'summary' AS explanation_summary, r.created_at
    FROM specs
    JOIN spec_revisions r ON r.spec_id = specs.id AND r.revision = specs.head_revision
    LEFT JOIN spec_revisions ra ON ra.spec_id = specs.id AND ra.revision = specs.approved_revision
    LEFT JOIN users u ON r.author_kind = 'user' AND u.id::text = r.author_id
    WHERE ${inArray(specs.workspaceId, ws.map((w) => w.id))} AND ${awaitingApprovalWhere()}
    ORDER BY r.created_at DESC, specs.id`));
  const tiers = await Promise.all(rows.map((r) => tierOf(r)));
  return sortHighFirst(rows.map((r, i) => ({
    tier: tiers[i]!.tier, tierReasons: tiers[i]!.reasons,
    specId: r.id, title: r.title, workspaceId: r.workspace_id, workspaceName: names.get(r.workspace_id) ?? '',
    headRevision: Number(r.head_revision), approvedRevision: r.approved_revision == null ? null : Number(r.approved_revision),
    version: Number(r.version), contentHash: r.content_hash,
    author: r.author_kind === 'user' ? (r.author_name ?? 'a person') : 'an agent',
    changeSummary: r.change_summary, explanationSummary: r.explanation_summary?.trim() || null, proposedAt: new Date(r.created_at).toISOString(),
  })));
}

/** The row's tier from its approved and head bodies; a body that cannot be read leaves it Medium, never High or Low by guess. */
async function tierOf(r: { scope: string; risk: string | null; body_artifact_id: string; head_artifact_revision: number; approved_artifact_revision: number | null; approved_content_hash: string | null; content_hash: string }) {
  try {
    const wanted = [r.head_artifact_revision, ...(r.approved_artifact_revision == null ? [] : [r.approved_artifact_revision])];
    const read = await getArtifactRevisions(r.body_artifact_id, wanted);
    const body = (n: number, hash: string | null) => { const a = read.get(n); return a && typeof a.content === 'string' && (!hash || a.contentHash === hash) ? a.content : null; };
    const to = body(r.head_artifact_revision, r.content_hash);
    const from = r.approved_artifact_revision == null ? null : body(r.approved_artifact_revision, r.approved_content_hash);
    if (to === null || (r.approved_artifact_revision != null && from === null)) {
      return r.risk === 'high' ? { tier: 'high' as const, reasons: ['A person flagged this spec risk: high.'] } : { tier: 'medium' as const, reasons: ['The change could not be read to rate it.'] };
    }
    return classifyRisk({ scope: r.scope, flaggedHigh: r.risk === 'high', from, to });
  } catch {
    return { tier: 'medium' as const, reasons: ['The change could not be read to rate it.'] };
  }
}

/** How many of the waiting rows the risk-tier classifier calls Low (Home's split, R-9). */
export const countLowRisk = (rows: ReadonlyArray<{ tier: RiskTier }>): number => rows.filter((r) => r.tier === 'low').length;

/** The Low-tier share of what waits on this person in these workspaces; 0 when it cannot be read. */
export async function countLowRiskAwaiting(userId: string, workspaceIds?: readonly string[]): Promise<number> {
  try {
    const rows = await listAwaitingApproval(userId);
    return countLowRisk(workspaceIds ? rows.filter((r) => workspaceIds.includes(r.workspaceId)) : rows);
  } catch { return 0; }
}

async function countWhere(where: SQL): Promise<number> {
  const [r] = await db.select({ n: count() }).from(specs).where(and(where, awaitingApprovalWhere()));
  return Number(r?.n ?? 0);
}

/** How many spec revisions wait on this person: Home's Needs you card (R-9). */
export async function countAwaitingApprovalFor(userId: string, workspaceIds?: readonly string[]): Promise<number> {
  const ws = (await approverWorkspaces(userId)).filter((w) => !workspaceIds || workspaceIds.includes(w.id));
  if (!ws.length) return 0;
  return countWhere(inArray(specs.workspaceId, ws.map((w) => w.id)));
}

/**
 * MCP `awaiting_approval` (R-7): read-only. From a person (a dashboard session
 * or their own OAuth session) the revisions that wait on them; from any other
 * caller the ones waiting in the workspace. Always the inbox link; never a
 * confirm token or anything else that approves.
 */
export async function countAwaitingApproval(caller: SpecCaller, workspaceId: string | null): Promise<
  { ok: true; count: number; scope: 'person' | 'workspace'; inboxUrl: string } | SpecError
> {
  const personId = caller.kind === 'user' ? caller.userId : requestingPerson(null, caller.account);
  if (personId) return { ok: true, count: await countAwaitingApprovalFor(personId), scope: 'person', inboxUrl: specApprovalInboxUrl() };
  if (!workspaceId || !isUuid(workspaceId)) return fail(400, 'workspaceId is required');
  if (!(await reach(caller, workspaceId, false))) return fail(404, 'Workspace not found');
  return { ok: true, count: await countWhere(sql`${specs.workspaceId} = ${workspaceId}::uuid`), scope: 'workspace', inboxUrl: specApprovalInboxUrl() };
}

/**
 * The people who may approve a workspace's specs: who an approval request is
 * sent to (R-10), never the whole team.
 */
export async function specApproverIds(workspaceId: string): Promise<string[]> {
  if (!isUuid(workspaceId)) return [];
  const rows = rowsOf<{ user_id: string; role: string; approvers: unknown }>(await db.execute(sql`
    SELECT tm.user_id, tm.role, w.git_config->'livingSpecs'->'approverUserIds' AS approvers
    FROM workspaces w JOIN team_members tm ON tm.team_id = w.team_id
    WHERE w.id = ${workspaceId}::uuid`));
  return rows.filter((r) => mayApproveIn(r.role, { livingSpecs: { approverUserIds: r.approvers } }, r.user_id)).map((r) => r.user_id);
}
