import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { db } from '@buildd/core/db';
import { workspaces, failureIncidents } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  FailureIncident,
  FailureIncidentRule,
  FailureIncidentSeverity,
  FailureIncidentStatus,
} from '@buildd/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEVERITIES: readonly FailureIncidentSeverity[] = ['low', 'medium', 'high', 'critical'];
const STATUSES: readonly FailureIncidentStatus[] = ['open', 'acknowledged', 'resolved'];
const RULES: readonly FailureIncidentRule[] = [
  'retry_fork',
  'lineage_multi_pr',
  'repeated_failure',
  'stranded_gate',
  'path_overlap_stall',
  'provider_attribution_mismatch',
  'failure_rate_spike',
  'output_unmet_boundary',
];
/** "Open incidents" by default means not yet resolved — acknowledged still needs eyes on it. */
const DEFAULT_STATUSES: readonly FailureIncidentStatus[] = ['open', 'acknowledged'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** critical first. Severity is stored as text (see schema), so ordering needs an explicit rank. */
const SEVERITY_ORDER = sql<number>`CASE ${failureIncidents.severity}
  WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END`;

type IncidentRow = typeof failureIncidents.$inferSelect;

/**
 * Same mapping `failure-incident-store.ts`'s `createDbIncidentPort` uses to
 * read a row — duplicated here (it is four field conversions, not a second
 * query implementation) rather than exported, because that module's port
 * exists for the write-side CAS loop and isn't in this task's declared paths.
 * Both read the one `failure_incidents` table; there is no second store.
 */
function toIncident(r: IncidentRow): FailureIncident {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    signature: r.signature,
    detectorVersion: r.detectorVersion,
    rule: r.rule,
    reasonCode: r.reasonCode,
    title: r.title,
    severity: r.severity,
    status: r.status,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    occurrenceCount: r.occurrenceCount,
    recurrenceCount: r.recurrenceCount,
    affectedRefs: r.affectedRefs ?? { taskIds: [], workerIds: [], prNumbers: [] },
    evidenceRefs: r.evidenceRefs ?? [],
    impact: r.impact ?? {},
    lastAlertedAt: r.lastAlertedAt ? r.lastAlertedAt.toISOString() : null,
    lastAlertSeverity: r.lastAlertSeverity,
    linkedFixTaskId: r.linkedFixTaskId,
    acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  };
}

function parseCsvEnum<T extends string>(raw: string | null, allowed: readonly T[], label: string): T[] | { error: string } {
  if (raw === null || raw.trim() === '') return [];
  const values = raw.split(',').map(v => v.trim()).filter(Boolean);
  for (const v of values) {
    if (!(allowed as readonly string[]).includes(v)) {
      return { error: `Invalid ${label}: "${v}". Expected one of ${allowed.join(', ')}.` };
    }
  }
  return values as T[];
}

/**
 * GET /api/health/incidents
 *
 * Failure Pattern Sentinel's incident ledger, read-only — the same
 * `failure_incidents` table the detector sweep writes, so this is the one
 * place to see what it has found: open incidents by severity, the pattern
 * behind each (signature/reason), first/last seen, occurrence count and
 * impact, representative task/worker/PR refs, alert state, any linked fix
 * task, and resolved/recurrence state.
 *
 * Query params:
 *   workspaceId — optional UUID; scopes to a single workspace. Omit for a
 *                 team-wide report (every workspace the caller can see).
 *   status      — CSV of open|acknowledged|resolved (default: "open,acknowledged",
 *                 i.e. not yet resolved). Pass "resolved" explicitly, or all
 *                 three, to see recurrence history.
 *   severity    — optional CSV of low|medium|high|critical; narrows the listed
 *                 rows. The severity breakdown in `counts` always covers every
 *                 severity within the status scope, regardless of this filter.
 *   rule        — optional CSV of detector rule names; narrows the listed rows.
 *   signature   — optional exact match on the incident's stable pattern signature.
 *   limit       — default 50, max 200.
 *
 *   teamId      — dashboard session only: pin to one of the user's teams.
 *
 * Auth: API key (scope = the key's team) or the dashboard session (scope = the
 * user's teams, or the pinned one).
 *
 * Response: { incidents: FailureIncident[], counts: { total, bySeverity } }
 * `counts.total` is the filtered row count regardless of `limit` — use it to
 * tell whether the list was truncated. `counts.bySeverity` is scoped by
 * workspace + status only (not by the `severity`/`rule`/`signature` filters).
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') ?? null;
    const account = await authenticateApiKey(apiKey, req);
    const sessionUser = account ? null : await getCurrentUser();
    if (!account && !sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);

    let teamIds: string[];
    if (account) {
      teamIds = account.teamId ? [account.teamId] : [];
    } else {
      const sessionTeamIds = await resolveSessionTeamIds(sessionUser!.id, searchParams.get('teamId'));
      if (!sessionTeamIds) {
        return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      }
      teamIds = sessionTeamIds;
    }
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });
    }

    const workspaceId = searchParams.get('workspaceId');
    let scopedWsIds: string[];
    if (workspaceId) {
      if (!UUID_RE.test(workspaceId)) {
        return NextResponse.json(
          { error: `Invalid workspaceId: expected a UUID, got "${workspaceId}". Resolve workspace names to UUIDs before calling this endpoint.` },
          { status: 400 },
        );
      }
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true, teamId: true },
      });
      if (!ws || !teamIds.includes(ws.teamId)) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scopedWsIds = [workspaceId];
    } else if (account) {
      const wsRows = await db.query.workspaces.findMany({
        where: eq(workspaces.teamId, account.teamId),
        columns: { id: true },
      });
      scopedWsIds = wsRows.map((w: { id: string }) => w.id);
    } else {
      scopedWsIds = await workspaceIdsForTeams(teamIds);
    }
    if (scopedWsIds.length === 0) {
      return NextResponse.json({ incidents: [], counts: { total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 } } });
    }

    const statusParam = searchParams.get('status');
    const statuses = statusParam === 'all'
      ? [...STATUSES]
      : parseCsvEnum(statusParam, STATUSES, 'status');
    if ('error' in (statuses as { error?: string })) return NextResponse.json(statuses, { status: 400 });
    const statusFilter = (statuses as FailureIncidentStatus[]).length > 0 ? (statuses as FailureIncidentStatus[]) : [...DEFAULT_STATUSES];

    const severities = parseCsvEnum(searchParams.get('severity'), SEVERITIES, 'severity');
    if ('error' in (severities as { error?: string })) return NextResponse.json(severities, { status: 400 });

    const rules = parseCsvEnum(searchParams.get('rule'), RULES, 'rule');
    if ('error' in (rules as { error?: string })) return NextResponse.json(rules, { status: 400 });

    const signature = searchParams.get('signature');

    const rawLimit = searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return NextResponse.json({ error: `Invalid limit: "${rawLimit}". Expected a positive integer.` }, { status: 400 });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const scopeCondition = inArray(failureIncidents.workspaceId, scopedWsIds);
    const statusCondition = inArray(failureIncidents.status, statusFilter);

    const conditions = [scopeCondition, statusCondition];
    if ((severities as FailureIncidentSeverity[]).length > 0) conditions.push(inArray(failureIncidents.severity, severities as FailureIncidentSeverity[]));
    if ((rules as FailureIncidentRule[]).length > 0) conditions.push(inArray(failureIncidents.rule, rules as FailureIncidentRule[]));
    if (signature) conditions.push(eq(failureIncidents.signature, signature));

    const [rows, totalRows, severityRows] = await Promise.all([
      db.select().from(failureIncidents).where(and(...conditions))
        .orderBy(desc(SEVERITY_ORDER), desc(failureIncidents.lastSeenAt))
        .limit(limit),
      db.select({ n: sql<number>`count(*)::int` }).from(failureIncidents).where(and(...conditions)),
      db.select({ severity: failureIncidents.severity, n: sql<number>`count(*)::int` })
        .from(failureIncidents)
        .where(and(scopeCondition, statusCondition))
        .groupBy(failureIncidents.severity),
    ]);

    const bySeverity: Record<FailureIncidentSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of severityRows) bySeverity[r.severity] = r.n;

    return NextResponse.json({
      incidents: rows.map(toIncident),
      counts: { total: totalRows[0]?.n ?? 0, bySeverity },
    });
  } catch (err) {
    console.error('[api/health/incidents] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
