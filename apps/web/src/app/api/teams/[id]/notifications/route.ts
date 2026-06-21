import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails } from '@/lib/team-access';
import {
  getTeamPreferences,
  setTeamPreferences,
  getTeamChannelStatus,
  setTeamChannel,
  deleteTeamChannel,
  type NotifyEvent,
  type ChannelPurpose,
} from '@/lib/notify';

type RouteContext = { params: Promise<{ id: string }> };

const EVENTS: NotifyEvent[] = ['taskClaimed', 'taskCompleted', 'taskFailed', 'credentialExpired'];

/** Resolve the caller and confirm they belong to the target team. */
async function authorize(teamId: string): Promise<{ ok: true } | { status: number; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { status: 401, error: 'Unauthorized' };
  // getUserTeamsWithDetails handles personal teams (no teamMembers rows) too.
  const teams = await getUserTeamsWithDetails(user.id);
  if (!teams.some((t) => t.id === teamId)) return { status: 404, error: 'Team not found' };
  return { ok: true };
}

// GET /api/teams/[id]/notifications — channel status (no values) + event prefs
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const auth = await authorize(id);
  if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [channels, preferences] = await Promise.all([
    getTeamChannelStatus(id),
    getTeamPreferences(id),
  ]);
  return NextResponse.json({ channels, preferences });
}

// PUT /api/teams/[id]/notifications — set channel secret(s) and/or event prefs.
// Body: { pushoverUserKey?: string|null, webhookUrl?: string|null, preferences?: Partial<Record<NotifyEvent, boolean>> }
// A channel field of '' or null clears it; omitting it leaves it unchanged.
export async function PUT(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const auth = await authorize(id);
  if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Channel secrets — never logged. Empty/null clears; undefined leaves as-is.
  const channelUpdates: Array<{ purpose: ChannelPurpose; value: string | null }> = [];
  if ('pushoverUserKey' in body) {
    channelUpdates.push({ purpose: 'pushover', value: normalizeChannelValue(body.pushoverUserKey) });
  }
  if ('webhookUrl' in body) {
    const v = normalizeChannelValue(body.webhookUrl);
    if (v && !/^https?:\/\//i.test(v)) {
      return NextResponse.json({ error: 'webhookUrl must be an http(s) URL' }, { status: 400 });
    }
    channelUpdates.push({ purpose: 'notify_webhook', value: v });
  }

  for (const u of channelUpdates) {
    if (u.value === null) await deleteTeamChannel(id, u.purpose);
    else await setTeamChannel(id, u.purpose, u.value);
  }

  // Event preferences — only known boolean keys are accepted.
  if (body.preferences && typeof body.preferences === 'object') {
    const prefs: Partial<Record<NotifyEvent, boolean>> = {};
    for (const ev of EVENTS) {
      const val = (body.preferences as Record<string, unknown>)[ev];
      if (typeof val === 'boolean') prefs[ev] = val;
    }
    if (Object.keys(prefs).length > 0) await setTeamPreferences(id, prefs);
  }

  const [channels, preferences] = await Promise.all([
    getTeamChannelStatus(id),
    getTeamPreferences(id),
  ]);
  return NextResponse.json({ channels, preferences });
}

function normalizeChannelValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}
