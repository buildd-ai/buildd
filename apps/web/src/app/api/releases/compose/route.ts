/**
 * The owner's release flow: Compose → Cut → Review → Release.
 *
 * GET  ?workspaceId=   the flow as it stands (composition, candidate, production, record)
 * POST { workspaceId, action, ... }   one button; see lib/release/compose-actions.ts
 *
 * Session only, and only a team owner or admin (`manage_releases`): every step
 * is a person pressing a button, recorded with who and when. No API key path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isGitHubAppConfigured } from '@/lib/github';
import { parseComposeAction, runComposeAction } from '@/lib/release/compose-actions';
import { composeActionDeps, loadFlowFor, resolveComposeTarget } from '@/lib/release/compose-runtime';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isGitHubAppConfigured()) return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  const target = await resolveComposeTarget(user.id, workspaceId);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
  const flow = await loadFlowFor(target.target);
  if (!flow.ok) return NextResponse.json({ error: flow.error }, { status: flow.status });
  return NextResponse.json(flow.view);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isGitHubAppConfigured()) return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.workspaceId !== 'string') return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  const action = parseComposeAction(body);
  if (!action) return NextResponse.json({ error: 'Unknown or malformed action' }, { status: 400 });
  const target = await resolveComposeTarget(user.id, body.workspaceId);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
  try {
    const res = await runComposeAction(target.target, user.id, action, composeActionDeps(target.target, req.nextUrl.origin));
    return NextResponse.json(res, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: `Internal error: ${message}` }, { status: 500 });
  }
}
