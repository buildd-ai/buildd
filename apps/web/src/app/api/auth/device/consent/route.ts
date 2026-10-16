import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { lookupDeviceCodeForConfirm, normalizeUserCode } from '@/lib/device-confirm';
import { approveDeviceCode } from '@/lib/device-approve';
import { runnerConsentTeams } from '@/lib/runner-picks';
import {
  RUNNER_CONSENT_HEADERS,
  decideRunnerConsent,
  initialRunnerState,
  isSameOriginPost,
  readFlow,
  renderRunnerConsentPage,
  renderRunnerDonePage,
  verifyRunnerConsentToken,
} from '@/lib/runner-consent';

export const dynamic = 'force-dynamic';

const ACTION = '/api/auth/device/consent';

function plain(message: string, status: number) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

function html(body: string, status = 200) {
  return new NextResponse(body, { status, headers: RUNNER_CONSENT_HEADERS });
}

function requestIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || null;
  return req.headers.get('x-real-ip');
}

/**
 * `buildd login --device` ends here (spec "One runner for every team you
 * run", R-1): the device page's Approve opens this page for the code, the
 * person picks workspaces across their teams, and Connect runner approves the
 * code with those picks. Loading the page never changes the code.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('code');
  const code = raw ? normalizeUserCode(raw) : '';
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    const back = code ? `/app/device?code=${encodeURIComponent(code)}` : '/app/device';
    return NextResponse.redirect(new URL(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`, req.url));
  }
  if (!code) return NextResponse.redirect(new URL('/app/device', req.url));

  const lookup = await lookupDeviceCodeForConfirm(code, userId);
  if (!lookup.ok) return NextResponse.redirect(new URL(`/app/device?code=${encodeURIComponent(code)}`, req.url));

  const teams = await runnerConsentTeams(userId);
  if (teams.length === 0) return plain('No workspaces available. Create one in buildd first.', 403);
  return html(renderRunnerConsentPage({
    flow: { kind: 'device', code },
    userId,
    teams,
    state: initialRunnerState(teams, null),
    action: ACTION,
  }));
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return plain('unsupported content-type', 400);
  }
  const form = new URLSearchParams(await req.text());
  const flow = readFlow('device', form);
  if (!flow || flow.kind !== 'device') return plain('code is required', 400);

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return plain('sign in required', 401);
  if (!isSameOriginPost(req)) return plain('consent must be submitted from this site', 403);
  if (!verifyRunnerConsentToken(form.get('csrf_token'), userId, flow)) {
    return plain('This page expired. Enter the code again.', 403);
  }

  const teams = await runnerConsentTeams(userId);
  const decision = decideRunnerConsent(form, teams);
  if (decision.type === 'deny') return NextResponse.redirect(new URL('/app/home', req.url), 303);
  if (decision.type === 'refuse') return plain(decision.message, decision.status);
  if (decision.type === 'page') {
    return html(renderRunnerConsentPage({ flow, userId, teams, state: decision.state, action: ACTION, error: decision.error }), decision.status ?? 200);
  }

  const result = await approveDeviceCode({
    userId,
    code: flow.code,
    workspaceIds: decision.workspaceIds,
    ip: requestIp(req),
    userAgent: req.headers.get('user-agent'),
  });
  if (!result.ok) return plain(result.message, result.status);
  return html(renderRunnerDonePage({
    title: 'Runner connected.',
    lede: 'Return to your terminal. It picks up the key on its own.',
  }));
}
