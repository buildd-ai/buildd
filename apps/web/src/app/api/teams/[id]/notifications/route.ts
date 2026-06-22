import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails } from '@/lib/team-access';
import {
  getTeamPreferences,
  setTeamPreferences,
  getTeamChannelStatus,
  setTeamPushover,
  setTeamWebhook,
  deleteTeamChannel,
  type NotifyEvent,
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
// Body: {
//   pushoverAppToken?: string|null,  // the team's OWN Pushover app token (required to set Pushover).
//   pushoverUserKey?: string|null,   // the team's Pushover user/group key (required to set Pushover).
//   webhookUrl?: string|null,        // '' or null clears the webhook.
//   preferences?: Partial<Record<NotifyEvent, boolean>>,
// }
// Pushover: send BOTH app token + user key to set; send both '' / null (or either
// null) to clear. We never fall back to buildd's app token — each team uses its own.
// Omitting a field leaves it unchanged.
export async function PUT(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const auth = await authorize(id);
  if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Pushover requires the team's own app token + user key. Channel secrets are never logged.
  if ('pushoverAppToken' in body || 'pushoverUserKey' in body) {
    const appToken = normalizeChannelValue(body.pushoverAppToken);
    const userKey = normalizeChannelValue(body.pushoverUserKey);
    if (appToken === null && userKey === null) {
      await deleteTeamChannel(id, 'pushover');
    } else if (appToken === null || userKey === null) {
      return NextResponse.json(
        { error: 'Pushover needs both an app token and a user/group key (or clear both to remove it)' },
        { status: 400 },
      );
    } else {
      await setTeamPushover(id, appToken, userKey);
    }
  }

  if ('webhookUrl' in body) {
    const url = normalizeChannelValue(body.webhookUrl);
    if (url === null) {
      await deleteTeamChannel(id, 'notify_webhook');
    } else if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'webhookUrl must be an http(s) URL' }, { status: 400 });
    } else {
      await setTeamWebhook(id, url);
    }
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
