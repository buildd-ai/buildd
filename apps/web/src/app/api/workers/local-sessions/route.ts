/**
 * The buildd agent plugin's presence endpoint.
 *
 * POST: one session event from a local client's lifecycle hook
 * ({ event: start|touch|bind|end, client, clientSessionId, ... }; contract in
 * packages/shared/src/local-session.ts). Auth: the person's presence token
 * (lib/presence-token.ts, minted by `buildd login`), or an account API key.
 * Presence only: nothing here creates a worker, holds a seat or writes a task.
 * `bind` attaches the presence to a worker the caller's own verified
 * claim_task already minted: the account's own, or, for a presence token,
 * one claimed in a team the person is in (by them, when the claim says who).
 *
 * GET: this account's team's recent local sessions (?workspaceId= narrows),
 * for a CLI `status` and the dashboard. API key only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { parseLocalSessionEvent } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { handleLocalSessionEvent, LocalSessionError, type LocalSessionPrincipal } from '@/lib/local-session';
import { authenticatePresenceToken, isPresenceToken } from '@/lib/presence-token';
import { listLocalSessions } from '@/lib/local-session-view';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';

export const dynamic = 'force-dynamic';

const MAX_BODY = 4_096;

function bearer(req: NextRequest): string | null {
  return req.headers.get('authorization')?.replace('Bearer ', '') || null;
}

async function authenticate(req: NextRequest) {
  return authenticateApiKey(bearer(req), req);
}

/** A presence token's person, or an API key's account. Null: 401. 'trigger': 403. */
async function principalFor(req: NextRequest): Promise<LocalSessionPrincipal | 'trigger' | null> {
  const token = bearer(req);
  if (isPresenceToken(token)) {
    const person = await authenticatePresenceToken(token);
    return person ? { kind: 'user', userId: person.userId, teamIds: person.teamIds } : null;
  }
  const account = await authenticateApiKey(token, req);
  if (!account) return null;
  // Presence can only be reported by a token that could also claim work.
  if (account.level === 'trigger') return 'trigger';
  return { id: account.id, teamId: account.teamId, workspaceIds: account.workspaceIds ?? null };
}

export async function POST(req: NextRequest) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const principal = await principalFor(req);
  if (!principal) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  if (principal === 'trigger') {
    return NextResponse.json({ error: 'forbidden', reason: 'trigger tokens cannot report sessions' }, { status: 403 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = parseLocalSessionEvent(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const res = await handleLocalSessionEvent(principal, parsed.event);
    return NextResponse.json(res);
  } catch (err) {
    if (err instanceof LocalSessionError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[local-sessions] event failed:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const account = await authenticate(req);
  if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  const reachable = (await listReachableWorkspaceIds({ account }))
    .filter(id => account.workspaceIds == null || account.workspaceIds.includes(id));
  const wanted = req.nextUrl.searchParams.get('workspaceId');
  if (wanted && !reachable.includes(wanted)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sessions = await listLocalSessions({
    workspaceIds: wanted ? [wanted] : reachable,
    // The caller's own sessions also show when no workspace matched their repo.
    accountIds: wanted ? undefined : [account.id],
  });
  return NextResponse.json({ sessions });
}
