/**
 * Capability requests through the escalation gate: an access request is a gate
 * subject (`capability_request:<id>`) with one fixed rule and no model call.
 *
 *  - pending (team policy asks a person, or a write/admin ask): the person's,
 *    rail `access_approval`. One Needs You card per request, which is already
 *    one row per (worker, target, exact ask): the store dedupes repeats.
 *  - granted by policy, or anything already decided: Buildd's. Informative on
 *    Settings → Connected apps → Agent access, never a card, never a push.
 *
 * Only people who can decide see the card: a pending request is listed for a
 * team where the viewer holds manage_connectors, since nobody else can approve
 * or deny it. Home and its badge read `loadAccessNeedsYou`; the push is sent
 * once, when a new pending request is written (`notifyAccessRequest`).
 *
 * Spec: docs/specs/capability-requests.md → Showing and deciding.
 */
import type { EscalationVerdict } from '@buildd/core/escalation-gate';
import type { WaitingOnYouRawItem } from './action-queue';
import { accessAsk, accessWho, approveLabel, formatLease, type AccessRequestView } from './capability-grants-view';

export const ACCESS_SUBJECT_TYPE = 'capability_request';
export const accessSubjectKey = (requestId: string) => `${ACCESS_SUBJECT_TYPE}:${requestId}`;

/** Where a person decides a request when the card cannot (a row, a push). */
export function accessRequestHref(requestId: string, baseUrl = ''): string {
  return `${baseUrl}/app/settings/connections?request=${encodeURIComponent(requestId)}#agent-access`;
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

/** Pure. The Needs You items for requests the gate gives to a person. */
export function accessNeedsYouItems(rows: readonly AccessRequestView[], baseUrl = ''): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id) || accessEscalationRule(r).owner !== 'person') continue;
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
 * Home's read: pending requests in the teams of these workspaces where the
 * viewer can decide. Never throws (Home keeps every other card).
 */
export async function loadAccessNeedsYou(userId: string | null | undefined, workspaceIds: readonly string[]): Promise<WaitingOnYouRawItem[]> {
  if (!userId || workspaceIds.length === 0) return [];
  try {
    const [{ db }, { workspaces }, { inArray }, { can }, { listTeamRequests }, { withRequestContext }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
      import('./permissions'), import('./capability-grants-store'), import('./capability-grants-context'),
    ]);
    const rows = await db.select({ id: workspaces.id, teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, [...workspaceIds]));
    const teamIds = [...new Set(rows.map(r => r.teamId).filter((t): t is string => !!t))];
    const visible = new Set(workspaceIds);
    const out: WaitingOnYouRawItem[] = [];
    for (const teamId of teamIds) {
      if (!(await can({ kind: 'user', userId }, 'manage_connectors', teamId))) continue;
      const pending = (await listTeamRequests(teamId, { status: ['pending'], limit: 25 })).filter(r => visible.has(r.workspaceId));
      out.push(...accessNeedsYouItems(await withRequestContext(pending) as unknown as AccessRequestView[]));
    }
    return out;
  } catch (err) {
    console.warn('[capability-grants-needs-you] Home access read failed (non-fatal):', (err as Error)?.message ?? err);
    return [];
  }
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
