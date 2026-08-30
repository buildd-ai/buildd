import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  getFailureAnalytics,
  normalizeErrorSignature,
  parseFailureWindow,
  FAILURE_WINDOWS,
} from '@/lib/failure-analytics';
import { toFrictionSignature } from '@buildd/core/failure-friction-signature';
import type { FailureAnalytics, FailureSignatureLookup } from '@buildd/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the first line of an error ever reaches the normalizer; the rest is trace. */
const MAX_LOOKUP_INPUT = 4000;
/** The echoed query is context for the caller, not data — keep it short. */
const MAX_ECHOED_QUERY = 300;

/**
 * Resolve one raw error string against the window's signature clusters.
 *
 * Normalization is delegated to the shared lib, so a lookup and the aggregation
 * can never disagree about what counts as "the same failure". A miss is a
 * normal answer (`known: false`), not an error — the caller asked a question.
 */
function lookupSignature(analytics: FailureAnalytics, rawError: string): FailureSignatureLookup {
  const signature = normalizeErrorSignature(rawError.slice(0, MAX_LOOKUP_INPUT));

  // diedEarlySignatures is a subset ranking; a signature can rank there while
  // being pushed out of the main ranking, so both are searched.
  const cluster =
    analytics.signatures.find(s => s.signature === signature) ??
    analytics.diedEarlySignatures.find(s => s.signature === signature) ??
    null;

  // When the ranking accounts for every failure in the window it was not
  // truncated, so `known: false` is definitive rather than "possibly ranked out".
  const ranked = analytics.signatures.reduce((sum, s) => sum + s.count, 0);

  return {
    query: rawError.length > MAX_ECHOED_QUERY ? `${rawError.slice(0, MAX_ECHOED_QUERY)}…` : rawError,
    signature,
    frictionSignature: toFrictionSignature(signature),
    known: cluster !== null,
    count: cluster?.count ?? 0,
    firstSeen: cluster?.firstSeen ?? null,
    lastSeen: cluster?.lastSeen ?? null,
    diedEarlyCount: cluster?.diedEarlyCount ?? 0,
    exitCauses: cluster?.exitCauses ?? [],
    exampleTaskId: cluster?.exampleTaskId ?? null,
    exhaustive: ranked >= analytics.totals.failed,
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
 *
 * Response: { analytics: FailureAnalytics, lookup?: FailureSignatureLookup }
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') ?? null;
    const account = await authenticateApiKey(apiKey);
    if (!account) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!account.teamId) {
      return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
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
      if (!ws || ws.teamId !== account.teamId) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scopedWsIds = [workspaceId];
    } else {
      const wsRows = await db.query.workspaces.findMany({
        where: eq(workspaces.teamId, account.teamId),
        columns: { id: true },
      });
      scopedWsIds = wsRows.map((w: { id: string }) => w.id);
    }

    const analytics = await getFailureAnalytics(scopedWsIds, window);

    // Lookup runs AFTER scoping, so it can only ever match the caller's own
    // failures — there is no path that resolves a signature outside the team.
    const rawError = searchParams.get('error');
    const lookupInput = rawError?.trim() ? rawError : null;
    if (lookupInput) {
      return NextResponse.json({ analytics, lookup: lookupSignature(analytics, lookupInput) });
    }

    return NextResponse.json({ analytics });
  } catch (err) {
    console.error('[GET /api/health/failures] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
