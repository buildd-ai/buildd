import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { isUuid } from '@/lib/uuid';
import { switchFeed, undoSwitch } from '@/lib/decision-model-optimizer/optimizer';
import { optimizerDeps, switchFeedDeps } from '@/lib/decision-model-optimizer/store';

/**
 * The decisions whose model buildd switched for this team
 * (lib/decision-model-optimizer/optimizer.ts), as the team sees them.
 *
 *   GET  → { lines: [{ id, kind, text, at }], canUndo }   any member
 *          One line per switch in effect: "Start or wait now uses Clef",
 *          "Start or wait is back on Jev". No scores or thresholds.
 *   POST { switchId, action: 'undo' } → { ok: true }      owner/admin
 *          Restores what the switch replaced and pins it for 30 days.
 *          409 when it was already undone, or the model was changed since.
 *
 * Session only.
 */

async function caller(req: NextRequest, teamId: string): Promise<{ response: Response } | { userId: string; canUndo: boolean }> {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  const userId = session.user.id;
  if (!(await getUserTeamIds(userId)).includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  return { userId, canUndo: await can({ kind: 'user', userId }, 'manage_team_settings', teamId) };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const c = await caller(req, id);
  if ('response' in c) return c.response;
  try {
    return NextResponse.json({ lines: await switchFeed(id, switchFeedDeps()), canUndo: c.canUndo });
  } catch (error) {
    console.error('[decision-model-switches] read failed:', error);
    return NextResponse.json({ lines: [], canUndo: false });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const c = await caller(req, id);
  if ('response' in c) return c.response;
  if (!c.canUndo) return NextResponse.json({ error: 'Only a team owner or admin can undo this.' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { switchId?: unknown; action?: unknown } | null;
  if (!body || body.action !== 'undo' || typeof body.switchId !== 'string' || !isUuid(body.switchId)) {
    return NextResponse.json({ error: "send { switchId, action: 'undo' }" }, { status: 400 });
  }
  const r = await undoSwitch({ teamId: id, switchId: body.switchId, by: c.userId }, optimizerDeps());
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}
