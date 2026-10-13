import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';
import { resolveConnectorTeam } from '@/lib/connector-team-auth';
import { notifyTeam } from '@/lib/notify';
import { appBaseUrl } from '@/lib/app-url';

/**
 * POST { slug } — a team member asks the team's admins to set up a catalog
 * app. Signed-in people only (an API key is not a person asking). Nothing is
 * installed or granted: the team is paged once on its own channel, and an
 * admin decides in Settings › Team › Apps. Refused for an entry the member
 * cannot see (blocked or not available) and for an admin, who can connect it.
 */
export async function POST(req: NextRequest) {
  const caller = await resolveConnectorTeam(req);
  if (caller instanceof NextResponse) return caller;
  if (caller.accountId) return NextResponse.json({ error: 'forbidden', message: 'Only a signed-in person can ask for an app.' }, { status: 403 });
  if (caller.canManage) return NextResponse.json({ error: 'can_manage', message: 'You can connect it yourself.' }, { status: 400 });

  let body: { slug?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const slug = typeof body.slug === 'string' ? body.slug : '';

  const entry = (await loadTeamCatalog(caller.teamId)).find(e => e.slug === slug);
  if (!entry || entry.policy === 'blocked' || entry.clientSupport) {
    return NextResponse.json({ error: 'not_found', message: 'That app is not offered to your team.' }, { status: 404 });
  }

  const user = await getCurrentUser();
  const who = user?.name?.trim() || user?.email || 'A team member';
  await notifyTeam(caller.teamId, 'needsAttention', {
    title: `${entry.name} requested`,
    message: `${who} asked for ${entry.name} for the team's agents.`,
    url: `${appBaseUrl()}/app/settings/apps`,
    urlTitle: 'Apps',
  });
  return NextResponse.json({ ok: true });
}
