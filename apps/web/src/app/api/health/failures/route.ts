import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  getFailureAnalytics,
  getFailureSignatureFamily,
  findSupersededErrorMatch,
  getFailureSignatureMatch,
  normalizeErrorSignature,
  parseFailureWindow,
  FAILURE_WINDOWS,
  type FailureWindow,
} from '@/lib/failure-analytics';
import { getGateAnalytics, getGateReasonFamily } from '@/lib/gate-analytics-query';
import { getLandingMetrics } from '@/lib/pr-landing-metrics';
import { getStalledIngestReport } from '@/lib/knowledge-ingest-stalls';
import { toFrictionSignature } from '@buildd/core/failure-friction-signature';
import type {
  FailureAnalytics,
  FailureSignatureFamily,
  FailureSignatureLookup,
  GateAnalytics,
  GateReasonFamily,
  LandingMetrics,
} from '@buildd/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the first line of an error ever reaches the normalizer; the rest is trace. */
const MAX_LOOKUP_INPUT = 4000;
/** The echoed query is context for the caller, not data — keep it short. */
const MAX_ECHOED_QUERY = 300;
/** A prefix longer than the max normalized signature (200 chars) can never match anything. */
const MAX_PREFIX_INPUT = 200;

/**
 * Resolve one raw error string against the window's signature clusters.
 *
 * Normalization is delegated to the shared lib, so a lookup and the aggregation
 * can never disagree about what counts as "the same failure". A miss is a
 * normal answer (`known: false`), not an error — the caller asked a question.
 *
 * When nothing in the ranked clusters matches, this falls back to
 * `workers.postSupersessionError` — a real error report that arrived for a
 * worker `/respond` had already superseded (see workers/[id]/route.ts). Those
 * workers are excluded from `analytics` entirely by design (superseded must
 * never move the failure rate), so without this fallback the exact text an
 * owner is staring at in the live feed would come back "New failure — no
 * match", even though the platform recorded it.
 */
async function lookupSignature(
  analytics: FailureAnalytics,
  rawError: string,
  scopedWsIds: string[],
  window: FailureWindow,
): Promise<FailureSignatureLookup> {
  const signature = normalizeErrorSignature(rawError.slice(0, MAX_LOOKUP_INPUT));
  const query = rawError.length > MAX_ECHOED_QUERY ? `${rawError.slice(0, MAX_ECHOED_QUERY)}…` : rawError;
  const frictionSignature = toFrictionSignature(signature);

  // When the ranking accounts for every failure in the window it was not
  // truncated, so `known: false` is definitive rather than "possibly ranked out".
  const ranked = analytics.signatures.reduce((sum, s) => sum + s.count, 0);
  const exhaustive = ranked >= analytics.totals.failed;

  // diedEarlySignatures is a subset ranking; a signature can rank there while
  // being pushed out of the main ranking, so both are searched.
  // Last, every failed row in scope: bookkeeping exits (a `Deferred:`
  // deferral, never_started, needs_input) are kept out of both rankings so they
  // do not move the failure rate, but friction dedupe must still find them.
  const cluster =
    analytics.signatures.find(s => s.signature === signature) ??
    analytics.diedEarlySignatures.find(s => s.signature === signature) ??
    (await getFailureSignatureMatch(scopedWsIds, window, signature));

  if (cluster) {
    return {
      query,
      signature,
      frictionSignature,
      known: true,
      count: cluster.count,
      firstSeen: cluster.firstSeen,
      lastSeen: cluster.lastSeen,
      diedEarlyCount: cluster.diedEarlyCount,
      exitCauses: cluster.exitCauses,
      exampleTaskId: cluster.exampleTaskId,
      exhaustive,
    };
  }

  const superseded = await findSupersededErrorMatch(scopedWsIds, window, signature);
  return {
    query,
    signature,
    frictionSignature,
    known: superseded !== null,
    count: superseded?.count ?? 0,
    firstSeen: superseded?.firstSeen ?? null,
    lastSeen: superseded?.lastSeen ?? null,
    diedEarlyCount: 0,
    exitCauses: [],
    exampleTaskId: superseded?.exampleTaskId ?? null,
    exhaustive,
    ...(superseded ? { supersededOnly: true } : {}),
  };
}

/**
 * GET /api/health/failures
 *
 * Aggregated worker failure analytics for the authenticated account's team —
 * the same numbers the health dashboard renders, so agents and CLIs never have
 * to hand-write SQL against prod to answer "why are workers dying?".
 *
 * Query params:
 *   window      — '24h' | '7d' | '30d' (default '7d'). Unknown values are rejected.
 *   workspaceId — optional UUID; scopes the report to a single workspace.
 *                 Omit for a team-wide report. Must be a UUID — resolve names
 *                 to UUIDs on the MCP layer before calling this route.
 *   error       — optional raw error text. When present, the response also
 *                 carries a `lookup` block answering "is this already a known
 *                 failure pattern?" for that one string. Blank values are
 *                 treated as absent. Read-only, like the rest of this route.
 *   errorPrefix — optional literal prefix (e.g. "needs_input:"). When present,
 *                 the response also carries a `family` block aggregating every
 *                 signature that starts with the prefix — for an error family
 *                 whose free-text tail makes each occurrence its own singleton
 *                 signature and invisible to both the overview and `error=`.
 *                 Blank values are treated as absent.
 *   family      — optional, currently only 'gate'. Switches the report to the
 *                 GATE LEDGER: server-side refusals, deferrals, advisory
 *                 warnings and explicit bypasses, which are invisible to every
 *                 param above because a creation-time 400 never becomes a
 *                 failed worker. Combine with `errorPrefix` to roll up gate
 *                 reasons sharing a literal prefix.
 *
 *   teamId      — dashboard session only: pin the scope to one of the user's
 *                 teams (default: all of them). A team the user is not in
 *                 404s. Ignored on the API key path, whose scope is its team.
 *
 * Auth: API key (scope = the key's team) or the dashboard session (scope = the
 * user's teams, or the pinned one). A key, when present, is authoritative.
 * A per-task token's scope is its own task's workspace.
 *
 * Response: { analytics, lookup?, family?, gates?, gateFamily?, stalledIngest? }
 *
 * `stalledIngest` (overview only, omitted when empty): full knowledge-ingest
 * jobs no runner has taken, and those the serverless fallback is running.
 *
 * `analytics` is always present, including under `family=gate` — the gate block
 * is additive, so an existing caller's parse never breaks.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') ?? null;
    // A per-task token reads failures only of its own task's workspace: a
    // team-wide request is narrowed to it, any other workspace is missing.
    const account = await authenticateTaskScopedCaller(apiKey, req);
    const sessionUser = account ? null : await getCurrentUser();
    if (!account && !sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);

    // The teams this caller may read: the key's own team, or the session
    // user's teams (optionally pinned to one of them).
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

    const rawWindow = searchParams.get('window');
    if (rawWindow !== null && !(FAILURE_WINDOWS as readonly string[]).includes(rawWindow)) {
      return NextResponse.json(
        { error: `Invalid window: "${rawWindow}". Expected one of ${FAILURE_WINDOWS.join(', ')}.` },
        { status: 400 },
      );
    }
    const window = parseFailureWindow(rawWindow);

    const workspaceId = searchParams.get('workspaceId') ?? null;

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
      if (!ws || !teamIds.includes(ws.teamId) || (account && !taskScopeAllowsWorkspace(account, ws.id))) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scopedWsIds = [workspaceId];
    } else if (account?.taskScope) {
      scopedWsIds = [account.taskScope.workspaceId];
    } else if (account) {
      const wsRows = await db.query.workspaces.findMany({
        where: eq(workspaces.teamId, account.teamId),
        columns: { id: true },
      });
      scopedWsIds = wsRows.map((w: { id: string }) => w.id);
    } else {
      scopedWsIds = await workspaceIdsForTeams(teamIds);
    }

    const analytics = await getFailureAnalytics(scopedWsIds, window);

    // Both lookup and family aggregation run AFTER scoping, so they can only
    // ever match the caller's own failures — there is no path that resolves a
    // signature outside the team.
    const rawError = searchParams.get('error');
    const lookupInput = rawError?.trim() ? rawError : null;

    const rawPrefix = searchParams.get('errorPrefix');
    const prefixInput = rawPrefix?.trim() ? rawPrefix.trim().slice(0, MAX_PREFIX_INPUT) : null;

    const rawFamily = searchParams.get('family');
    if (rawFamily !== null && rawFamily !== 'gate') {
      return NextResponse.json(
        { error: `Invalid family: "${rawFamily}". The only supported value is "gate".` },
        { status: 400 },
      );
    }
    const gateMode = rawFamily === 'gate';

    if (lookupInput || prefixInput || gateMode) {
      const body: {
        analytics: FailureAnalytics;
        lookup?: FailureSignatureLookup;
        family?: FailureSignatureFamily;
        gates?: GateAnalytics;
        gateFamily?: GateReasonFamily;
        landing?: LandingMetrics;
      } = { analytics };
      if (lookupInput) body.lookup = await lookupSignature(analytics, lookupInput, scopedWsIds, window);
      // `errorPrefix` means different things on the two families, so it is
      // routed to exactly one of them rather than answered twice: over gate
      // reasons under family=gate, over worker error signatures otherwise.
      if (prefixInput && !gateMode) body.family = await getFailureSignatureFamily(scopedWsIds, window, prefixInput);
      if (gateMode) {
        body.gates = await getGateAnalytics(scopedWsIds, window);
        if (prefixInput) body.gateFamily = await getGateReasonFamily(scopedWsIds, window, prefixInput);
        // Time-to-land is a property of the pr_landing gate, shown with the
        // overview; a prefix drill-down has no use for it. Null (read failed or
        // empty scope) is omitted rather than reported as zero landings.
        else {
          const landing = await getLandingMetrics(scopedWsIds, window);
          if (landing) body.landing = landing;
        }
      }
      return NextResponse.json(body);
    }

    // Full ingest jobs no runner takes never become failed workers; the
    // overview names them so they are not only visible in a claim response.
    const stalledIngest = await getStalledIngestReport(scopedWsIds);
    return NextResponse.json(stalledIngest ? { analytics, stalledIngest } : { analytics });
  } catch (err) {
    console.error('[GET /api/health/failures] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
