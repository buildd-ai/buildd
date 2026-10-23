/**
 * Capability requests through the escalation gate: an access request is a gate
 * subject (`capability_request:<id>`) with one fixed rule and no model call.
 *
 *  - pending (team policy asks a person, or a write/admin ask): the person's,
 *    rail `access_approval`. One Needs You card per request, which is already
 *    one row per (worker, target, exact ask): the store dedupes repeats.
 *  - granted by policy, or anything already decided: Buildd's. Informative on
 *    Settings › Team › Apps › Agent access, never a card, never a push.
 *
 * Only people who can decide see the card: a pending request is listed for a
 * team where the viewer holds manage_connectors, since nobody else can approve
 * or deny it. Only an open request is a card: pending on a run that has not
 * ended (`isOpenAccessRequest`). A request whose task or agent run ended is
 * closed, even before its row says so, and is neither a card nor counted. Home reads `accessNeedsYouRead`; the push is sent
 * once, when a new pending request is written (`notifyAccessRequest`).
 *
 * Spec: docs/specs/capability-requests.md → Showing and deciding.
 */
import type { EscalationVerdict } from '@buildd/core/escalation-gate';
import type { WaitingOnYouRawItem } from './action-queue';
import { accessAsk, accessWho, approveLabel, formatLease, type AccessRequestView } from './capability-grants-view';
import { isOpenAccessRequest } from './open-ask';

export const ACCESS_SUBJECT_TYPE = 'capability_request';
export const accessSubjectKey = (requestId: string) => `${ACCESS_SUBJECT_TYPE}:${requestId}`;

/** Where a person decides a request when the card cannot (a row, a push). */
export function accessRequestHref(requestId: string, baseUrl = ''): string {
  return `${baseUrl}/app/settings/apps?request=${encodeURIComponent(requestId)}#agent-access`;
}

/** Pure. The gate's verdict for one request. */
export function accessEscalationRule(r: Pick<AccessRequestView, 'status' | 'decidedBy'>): EscalationVerdict {
  if (r.status === 'pending') {
    return { owner: 'person', by: 'rule', rail: 'access_approval', reason: 'An agent asked for access that team policy leaves to a person.' };
  }
  if (r.status === 'granted' && r.decidedBy === 'policy') {
    return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Allowed by team policy; nothing to decide.' };
  }
  return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Already decided.' };
}

/** A request as Home reads it: with the live status of the run it is bound to. */
export type AccessRequestOnRun = AccessRequestView & { taskStatus: string | null; workerStatus: string | null };

/**
 * Pure. The Needs You items for requests the gate gives to a person and that
 * are still open: a pending row on an ended run is closed, and gets no card.
 */
export function accessNeedsYouItems(rows: readonly AccessRequestOnRun[], baseUrl = ''): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id) || accessEscalationRule(r).owner !== 'person') continue;
    if (!isOpenAccessRequest(r.status, r.taskStatus, r.workerStatus)) continue;
    seen.add(r.id);
    items.push({
      kind: 'access',
      accessRequestId: r.id,
      accessAsk: accessAsk(r),
      accessTtlSeconds: r.ttlSeconds,
      accessApproveLabel: approveLabel(r.ttlSeconds),
      taskId: r.taskId,
      taskTitle: r.taskTitle ?? undefined,
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName ?? null,
      failureMessage: [accessWho(r), r.reason?.trim() ? `"${r.reason.trim()}"` : null].filter(Boolean).join(': '),
      fixHref: accessRequestHref(r.id, baseUrl),
      fixLabel: 'Review',
    });
  }
  return items;
}

/**
 * Home's read as one statement for its batch: the team's pending requests in
 * these workspaces on runs that have not ended (newest first, at most 25),
 * with each one's task title, workspace name and run status. The run filter
 * is in the query too, so closed rows never crowd open ones out of the 25.
 * Only a viewer who can decide them (manage_connectors) asks. `items` turns
 * the rows into Needs You items. Reads only: lapsed grants and requests whose
 * run ended are closed by `expire`, which Home runs after its response.
 */
export async function accessNeedsYouRead(teamId: string, workspaceIds: readonly string[]) {
  const [{ db }, { capabilityGrants, tasks, workers, workspaces }, { and, desc, eq, inArray }, { grantView, toGrantRecord, expireLapsedTeamGrants }, { OPEN_TASK_STATUSES, LIVE_WORKER_STATUSES }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./capability-grants-store'), import('@buildd/shared'),
  ]);
  const query = db.select({ grant: capabilityGrants, taskTitle: tasks.title, taskStatus: tasks.status, workerStatus: workers.status, workspaceName: workspaces.name })
    .from(capabilityGrants)
    .leftJoin(tasks, eq(tasks.id, capabilityGrants.taskId))
    .leftJoin(workers, eq(workers.id, capabilityGrants.workerId))
    .leftJoin(workspaces, eq(workspaces.id, capabilityGrants.workspaceId))
    .where(and(
      eq(capabilityGrants.teamId, teamId),
      eq(capabilityGrants.status, 'pending'),
      inArray(capabilityGrants.workspaceId, [...workspaceIds]),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
    ))
    .orderBy(desc(capabilityGrants.requestedAt))
    .limit(25);
  type Row = Awaited<typeof query>[number];
  return {
    query,
    items: (rows: readonly Row[]): WaitingOnYouRawItem[] => accessNeedsYouItems(rows.map(r => ({
      ...grantView({ ...toGrantRecord(r.grant), reason: r.grant.reason, decisionReason: r.grant.decisionReason, requestedAt: r.grant.requestedAt, decidedAt: r.grant.decidedAt }),
      taskTitle: r.taskTitle ?? null, workspaceName: r.workspaceName ?? null, decidedByName: null,
      taskStatus: r.taskStatus ?? null, workerStatus: r.workerStatus ?? null,
    })) as unknown as AccessRequestOnRun[]),
    expire: () => expireLapsedTeamGrants(teamId),
  };
}

/** The push for a new pending request: what, who, and the lease asked for. Pure. */
export function accessPushPayload(r: AccessRequestView, baseUrl: string) {
  return {
    title: `Access request: ${accessAsk(r)}`,
    message: `${accessWho(r)} asks for ${formatLease(r.ttlSeconds)}.${r.reason?.trim() ? ` "${r.reason.trim().slice(0, 200)}"` : ''}`,
    url: accessRequestHref(r.id, baseUrl),
    urlTitle: 'Review request',
    priority: 0 as const,
  };
}

/**
 * Page the team once for a newly written pending request. A deduped ask (the
 * same row again) is not new and is not sent. Never throws.
 */
export async function notifyAccessRequest(teamId: string, r: AccessRequestView): Promise<void> {
  if (accessEscalationRule(r).owner !== 'person') return;
  try {
    const [{ notifyTeam }, { appBaseUrl }] = await Promise.all([import('./notify'), import('./app-url')]);
    await notifyTeam(teamId, 'needsAttention', accessPushPayload(r, appBaseUrl()));
  } catch (err) {
    console.warn('[capability-grants-needs-you] push failed (non-fatal):', (err as Error)?.message ?? err);
  }
}
