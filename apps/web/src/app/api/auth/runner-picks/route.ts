import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isUuid } from '@/lib/uuid';
import { listRunnerKeys, replaceRunnerPicks, runnerConsentTeams } from '@/lib/runner-picks';
import {
  RUNNER_CONSENT_HEADERS,
  decideRunnerConsent,
  initialRunnerState,
  isSameOriginPost,
  readFlow,
  renderRunnerConsentPage,
  verifyRunnerConsentToken,
} from '@/lib/runner-consent';

export const dynamic = 'force-dynamic';

const ACTION = '/api/auth/runner-picks';
const SETTINGS = '/app/settings/connections';

function plain(message: string, status: number) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

/**
 * Reopen the runner consent page for an existing key with its current picks
 * (spec "One runner for every team you run", R-4, AC-4): Settings' Edit, and
 * what `buildd login --workspaces` can open. Saving replaces the picks; the key
 * stays the same. Only the person who minted the key gets the page.
 */
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get('account') ?? '';
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    const back = `${ACTION}?account=${encodeURIComponent(accountId)}`;
    return NextResponse.redirect(new URL(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`, req.url));
  }
  if (!isUuid(accountId)) return plain('Key not found', 404);
  const key = (await listRunnerKeys(userId)).find((k) => k.id === accountId);
  if (!key) return plain('Key not found', 404);

  const teams = await runnerConsentTeams(userId);
  if (teams.length === 0) return plain('No workspaces available.', 403);
  const html = renderRunnerConsentPage({
    flow: { kind: 'edit', accountId, accountName: key.name },
    userId,
    teams,
    state: initialRunnerState(teams, (key.picks ?? []).map((p) => p.workspaceId)),
    action: ACTION,
  });
  return new NextResponse(html, { status: 200, headers: RUNNER_CONSENT_HEADERS });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return plain('unsupported content-type', 400);
  }
  const form = new URLSearchParams(await req.text());
  const flow = readFlow('edit', form);
  if (!flow || flow.kind !== 'edit' || !isUuid(flow.accountId)) return plain('Key not found', 404);

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return plain('sign in required', 401);
  if (!isSameOriginPost(req)) return plain('consent must be submitted from this site', 403);
  if (!verifyRunnerConsentToken(form.get('csrf_token'), userId, flow)) {
    return plain('This page expired. Open Edit again.', 403);
  }

  const key = (await listRunnerKeys(userId)).find((k) => k.id === flow.accountId);
  if (!key) return plain('Key not found', 404);
  const named = { ...flow, accountName: key.name };

  const teams = await runnerConsentTeams(userId);
  const decision = decideRunnerConsent(form, teams);
  if (decision.type === 'deny') return NextResponse.redirect(new URL(SETTINGS, req.url), 303);
  if (decision.type === 'refuse') return plain(decision.message, decision.status);
  if (decision.type === 'page') {
    const html = renderRunnerConsentPage({ flow: named, userId, teams, state: decision.state, action: ACTION, error: decision.error });
    return new NextResponse(html, { status: decision.status ?? 200, headers: RUNNER_CONSENT_HEADERS });
  }

  const result = await replaceRunnerPicks({ accountId: flow.accountId, userId, workspaceIds: decision.workspaceIds });
  if (!result.ok) {
    if (result.status === 404) return plain(result.message, 404);
    const html = renderRunnerConsentPage({
      flow: named, userId, teams, state: initialRunnerState(teams, decision.workspaceIds), action: ACTION, error: result.message,
    });
    return new NextResponse(html, { status: result.status, headers: RUNNER_CONSENT_HEADERS });
  }
  return NextResponse.redirect(new URL(SETTINGS, req.url), 303);
}
