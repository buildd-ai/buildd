/**
 * Dev fixture: the OAuth consent pages with fake data, for visual review (no
 * database, no session, nothing can be submitted from it: the form posts to a
 * path that does not exist).
 *
 *   /app/dev/oauth-consent                ChatGPT (verified), agent, one preselected
 *   /app/dev/oauth-consent?view=person    the client asked to act as the person (unverified CLI)
 *   /app/dev/oauth-consent?view=paged     a large team on page 2, with a search
 *   /app/dev/oauth-consent?view=dupes     same-named workspaces, told apart by repo
 *   /app/dev/oauth-consent?view=empty     a search that matches nothing
 *   /app/dev/oauth-consent?view=error     an approval with nothing chosen
 *   /app/dev/oauth-consent?view=legacy    an app still on an older per-workspace address
 *   /app/dev/oauth-consent?view=done      the screen after approving
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  initialConsentState,
  pickerTeams,
  renderAccountConsentPage,
  renderGrantInterstitial,
  renderLegacyConsentPage,
  type ConsentTeam,
} from '@/lib/oauth/account-consent';

export const dynamic = 'force-dynamic';

const names = ['api', 'billing', 'docs', 'dashboard', 'ingest', 'mobile', 'notifications', 'payments', 'search', 'site'];

function team(id: string, name: string, role: string, n: number, org: string): ConsentTeam {
  return {
    id,
    name,
    role,
    workspaces: [
      // Every team has an internal coordination workspace; the picker hides it.
      { id: `${id}-coord`, name: '__coordination', repo: null, system: true },
      ...Array.from({ length: n }, (_, i) => {
        const ws = i < names.length ? names[i] : `service-${String(i).padStart(2, '0')}`;
        return { id: `${id}-ws-${i}`, name: ws, repo: `${org}/${ws}`, system: false };
      }),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const TEAMS: ConsentTeam[] = [
  team('team-a', 'Acme Platform', 'owner', 46, 'acme'),
  team('team-b', 'Side projects', 'member', 3, 'jo'),
  team('team-c', 'Design lab', 'admin', 2, 'acme-design'),
];

// Same names across and within teams, as people really have them.
const DUPES: ConsentTeam[] = [
  { id: 'team-a', name: 'Acme Platform', role: 'owner', workspaces: [
    { id: 'team-a-coord', name: '__coordination', repo: null, system: true },
    { id: 'a1', name: 'api', repo: 'acme/api' },
    { id: 'a2', name: 'api', repo: 'acme/api-legacy' },
    { id: 'a3', name: 'docs', repo: null },
    { id: 'a4aaaaaa-0000', name: 'docs', repo: null },
    { id: 'a5', name: 'web', repo: 'acme/web' },
  ] },
  { id: 'team-b', name: 'Acme Labs', role: 'member', workspaces: [
    { id: 'team-b-coord', name: '__coordination', repo: null, system: true },
    { id: 'b1', name: 'api', repo: 'acme-labs/api' },
    { id: 'b2', name: 'web', repo: 'acme-labs/web' },
  ] },
];

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view') ?? 'default';
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (view === 'done') {
    return new NextResponse(
      renderGrantInterstitial({ clientName: 'ChatGPT', redirectUrl: 'https://client.example/callback', workspaceCount: 3, actsAs: 'agent' }),
      { headers },
    );
  }
  if (view === 'legacy') {
    return new NextResponse(renderLegacyConsentPage({
      clientName: 'ChatGPT',
      clientVerified: true,
      redirectHost: 'chatgpt.com',
      hidden: [['csrf_token', 'fixture']],
      workspace: { name: 'api', teamName: 'Acme Platform', repo: 'acme/api' },
      level: 'admin',
      canonicalUrl: 'https://buildd.dev/api/mcp',
      action: '/app/dev/oauth-consent/not-a-real-endpoint',
    }), { headers });
  }
  const teams = pickerTeams(view === 'dupes' ? DUPES : TEAMS, null);
  const requested = { write: true, person: view === 'person' };
  const state = initialConsentState(teams, requested, null);
  if (view === 'paged') {
    state.selected = ['team-a-ws-0', 'team-a-ws-30', 'team-b-ws-1'];
    state.pages = { 'team-a': 2 };
    state.query = 'service';
  }
  if (view === 'dupes') state.selected = ['a1', 'b1'];
  if (view === 'empty') state.query = 'kubernetes';
  if (view === 'error') state.selected = [];
  const cli = view === 'person';
  const html = renderAccountConsentPage({
    clientName: cli ? 'buildd CLI' : 'ChatGPT',
    clientVerified: !cli,
    redirectHost: cli ? '127.0.0.1:41776' : 'chatgpt.com',
    hidden: [['csrf_token', 'fixture']],
    teams,
    state,
    requested,
    error: view === 'error' ? 'Choose at least one workspace.' : null,
    action: '/app/dev/oauth-consent/not-a-real-endpoint',
  });
  return new NextResponse(html, { headers });
}
