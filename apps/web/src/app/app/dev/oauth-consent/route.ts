/**
 * Dev fixture: the account-level OAuth consent page with fake data, for
 * visual review (no database, no session, nothing can be submitted from it:
 * the form posts to a path that does not exist).
 *
 *   /app/dev/oauth-consent                default: agent, one preselected
 *   /app/dev/oauth-consent?view=person    the client asked to act as the person
 *   /app/dev/oauth-consent?view=paged     a large team on page 2, with a search
 *   /app/dev/oauth-consent?view=error     an approval with nothing chosen
 *   /app/dev/oauth-consent?view=done      the screen after approving
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  initialConsentState,
  renderAccountConsentPage,
  renderGrantInterstitial,
  type ConsentTeam,
} from '@/lib/oauth/account-consent';

export const dynamic = 'force-dynamic';

const names = ['api', 'billing', 'docs', 'dashboard', 'ingest', 'mobile', 'notifications', 'payments', 'search', 'site'];

function team(id: string, name: string, role: string, n: number): ConsentTeam {
  return {
    id,
    name,
    role,
    workspaces: Array.from({ length: n }, (_, i) => ({
      id: `${id}-ws-${i}`,
      name: i < names.length ? names[i] : `service-${String(i).padStart(2, '0')}`,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const TEAMS: ConsentTeam[] = [
  team('team-a', 'Acme Platform', 'owner', 46),
  team('team-b', 'Side projects', 'member', 3),
  team('team-c', 'Design lab', 'admin', 2),
];

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view') ?? 'default';
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (view === 'done') {
    return new NextResponse(
      renderGrantInterstitial({ clientName: 'Claude', redirectUrl: 'https://client.example/callback', workspaceCount: 3, actsAs: 'agent' }),
      { headers },
    );
  }
  const requested = { write: true, person: view === 'person' };
  const state = initialConsentState(TEAMS, requested, null);
  if (view === 'paged') {
    state.selected = ['team-a-ws-0', 'team-a-ws-30', 'team-b-ws-1'];
    state.pages = { 'team-a': 2 };
    state.query = 'service';
  }
  if (view === 'error') state.selected = [];
  const html = renderAccountConsentPage({
    clientName: view === 'person' ? 'buildd CLI' : 'Claude',
    redirectHost: view === 'person' ? '127.0.0.1:41776' : 'claude.ai',
    hidden: [['csrf_token', 'fixture']],
    teams: TEAMS,
    state,
    requested,
    error: view === 'error' ? 'Choose at least one workspace.' : null,
    action: '/app/dev/oauth-consent/not-a-real-endpoint',
  });
  return new NextResponse(html, { headers });
}
