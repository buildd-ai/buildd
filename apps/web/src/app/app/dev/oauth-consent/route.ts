/**
 * Dev fixture: the OAuth consent pages with fake data, for visual review (no
 * database, no session, nothing can be submitted from it: the form posts to a
 * path that does not exist).
 *
 *   /app/dev/oauth-consent                ChatGPT (verified), agent, three teams, none chosen yet
 *   /app/dev/oauth-consent?view=chosen    one team on all current and future workspaces, one on specific
 *   /app/dev/oauth-consent?view=person    the client asked to act as the person (unverified CLI)
 *   /app/dev/oauth-consent?view=paged     a large team on specific workspaces, page 2, with a search
 *   /app/dev/oauth-consent?view=dupes     same-named workspaces, told apart by repo
 *   /app/dev/oauth-consent?view=empty     a search that matches nothing
 *   /app/dev/oauth-consent?view=error     an approval with nothing chosen
 *   /app/dev/oauth-consent?view=unnamed   a team whose name is blank reads "Unnamed team <id>"
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
import { displayTeamName } from '@buildd/shared';

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

// A team whose stored name is blank (synthetic ids).
const UNNAMED: ConsentTeam[] = [
  team('team-a', 'Acme Platform', 'owner', 4, 'acme'),
  team('f0f0a1b2-unnamed', '   ', 'member', 2, 'example'),
];

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view') ?? 'default';
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (view === 'done') {
    return new NextResponse(
      renderGrantInterstitial({
        clientName: 'ChatGPT',
        redirectUrl: 'https://client.example/callback',
        teams: [{ name: 'Acme Platform', mode: 'all', count: 46 }, { name: 'Side projects', mode: 'specific', count: 2 }],
        actsAs: 'agent',
      }),
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
  const source = view === 'dupes' ? DUPES : view === 'unnamed' ? UNNAMED : TEAMS;
  const teams = pickerTeams(source.map((t) => ({ ...t, name: displayTeamName(t.name, t.id) })), null);
  const requested = { write: true, person: view === 'person' };
  const state = initialConsentState(teams, requested, null);
  if (view === 'chosen' || view === 'person') {
    state.teamModes = { 'team-a': 'all', 'team-b': 'specific' };
    state.selected = ['team-b-ws-0', 'team-b-ws-2'];
  }
  if (view === 'paged') {
    state.teamModes = { 'team-a': 'specific', 'team-b': 'all' };
    state.selected = ['team-a-ws-0', 'team-a-ws-30'];
    state.pages = { 'team-a': 2 };
    state.query = 'service';
  }
  if (view === 'dupes') {
    state.teamModes = { 'team-a': 'specific', 'team-b': 'specific' };
    state.selected = ['a1', 'b1'];
  }
  if (view === 'unnamed') state.teamModes = { [UNNAMED[1].id]: 'all' };
  if (view === 'empty') state.query = 'kubernetes';
  const cli = view === 'person';
  const html = renderAccountConsentPage({
    clientName: cli ? 'buildd CLI' : 'ChatGPT',
    clientVerified: !cli,
    redirectHost: cli ? '127.0.0.1:41776' : 'chatgpt.com',
    hidden: [['csrf_token', 'fixture']],
    teams,
    state,
    requested,
    error: view === 'error' ? 'Choose at least one team, and whether the app reaches all of its workspaces or specific ones.' : null,
    action: '/app/dev/oauth-consent/not-a-real-endpoint',
  });
  return new NextResponse(html, { headers });
}
