'use client';

/**
 * `?state=mcp-connections`: Settings → Connected apps with fake data and a
 * local api (nothing is sent anywhere). Sections, top to bottom: the page as a
 * team admin sees it (your apps with an "acts as you" connection open and
 * older connections folded; team apps with one open); team apps as a member
 * sees them; an agent connection open, with a workspace out of reach; the
 * workspace picker, as "Add or remove" opens it, on a large team; no
 * connections.
 */
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import ConnectionsSection, { type ConnectionsApi, type ConnectionsData } from '../../(protected)/settings/connections/ConnectionsSection';
import WorkspacePicker from '../../(protected)/settings/connections/WorkspacePicker';
import TeamAppsSection, { type TeamAppsData } from '../../(protected)/settings/connections/connectors/TeamAppsSection';
import { CONNECTOR_CATALOG, customerCatalogEntry } from '@/lib/connector-catalog';
import type { ConnectionSummary } from '@/lib/mcp-grant-patch';
import type { ConsentTeam } from '@/lib/oauth/account-consent';

const NOW = new Date('2026-10-09T12:00:00Z');
const names = ['api', 'billing', 'docs', 'dashboard', 'ingest', 'mobile', 'notifications', 'payments', 'search', 'site'];
function team(id: string, name: string, role: string, n: number): ConsentTeam {
  return {
    id, name, role,
    workspaces: Array.from({ length: n }, (_, i) => ({ id: `${id}-ws-${i}`, name: i < names.length ? names[i] : `service-${String(i).padStart(2, '0')}` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
const TEAMS: ConsentTeam[] = [team('team-a', 'Acme Platform', 'owner', 26), team('team-b', 'Side projects', 'member', 3)];
const ws = (t: ConsentTeam, i: number) => ({ id: t.workspaces[i].id, name: t.workspaces[i].name, teamId: t.id, teamName: t.name });

const PERSON: ConnectionSummary = {
  id: 'fixture-person', clientName: 'Claude Code', actsAs: 'person', access: 'read-write',
  createdAt: '2026-09-20T09:00:00Z', lastActiveAt: '2026-10-09T10:40:00Z', expiresAt: null, unreachableCount: 0,
  workspaces: [ws(TEAMS[0], 0), ws(TEAMS[0], 2), ws(TEAMS[1], 1)],
};
const AGENT: ConnectionSummary = {
  id: 'fixture-agent', clientName: 'Team connector', actsAs: 'agent', access: 'read',
  createdAt: '2026-09-02T09:00:00Z', lastActiveAt: '2026-10-06T08:00:00Z', expiresAt: null, unreachableCount: 1,
  workspaces: [ws(TEAMS[0], 4)],
};

const localApi: ConnectionsApi = {
  async patch(id, body) {
    const base = id === PERSON.id ? PERSON : AGENT;
    return { ok: true, connection: { ...base, ...(body.access ? { access: body.access } : {}), ...(body.actsAs ? { actsAs: body.actsAs } : {}) } };
  },
  async revoke() { return { ok: true }; },
};

const data = (d: Partial<ConnectionsData>): ConnectionsData => ({ connections: [PERSON, AGENT], legacy: [], teams: TEAMS, ...d });

const TEAM_WS = TEAMS[0].workspaces.slice(0, 4);
const CATALOG = CONNECTOR_CATALOG.map((e) => customerCatalogEntry({ ...e, id: null, source: 'builtin', policy: e.slug === 'posthog' ? 'blocked' : e.slug === 'context7' ? 'preinstalled' : 'available' }));
const connector = (slug: string, over: Partial<TeamAppsData['connectors'][number]> = {}): TeamAppsData['connectors'][number] => {
  const e = CONNECTOR_CATALOG.find((x) => x.slug === slug)!;
  return { id: `fixture-${slug}`, name: e.name, url: e.url, authMode: e.authMode, status: 'connected', iconUrl: null, ...over };
};
const CONNECTORS = [
  connector('axiom'),
  connector('sentry', { status: 'expired' }),
  connector('linear', { shared: true, ownerTeamName: 'Side projects' }),
  connector('context7'),
  { id: 'fixture-internal', name: 'Internal tools', url: 'https://tools.acme.example/mcp', authMode: 'header' as const, status: 'not_connected' as const },
];
const ADMIN: TeamAppsData = {
  canManage: true,
  entries: CATALOG,
  connectors: CONNECTORS,
  enabled: { 'fixture-axiom': TEAM_WS.slice(0, 2).map((w) => w.id), 'fixture-context7': TEAM_WS.map((w) => w.id), 'fixture-sentry': [TEAM_WS[0].id] },
};
// What the API hands a member: no blocked or unavailable entries.
const MEMBER: TeamAppsData = { ...ADMIN, canManage: false, entries: CATALOG.filter((e) => e.policy !== 'blocked' && !e.unavailable) };

export default function ConnectionsFixture() {
  const description = "Apps you connected to buildd, and the outside tools your team's agents can call.";
  return (
    <div className="min-h-screen bg-surface-1">
      <SettingsPage title="Connected apps" description={description}>
        <ConnectionsSection
          api={localApi}
          now={NOW}
          initiallyOpen={PERSON.id}
          initial={data({ legacy: [{ clientName: 'Claude Code', workspaceName: 'billing', lastActiveAt: '2026-10-07T12:00:00Z' }] })}
        />
        <TeamAppsSection workspaces={TEAM_WS} initial={ADMIN} initiallyOpen="axiom" />
      </SettingsPage>
      <SettingsPage title="Connected apps: a member" description="Fixture: team apps read-only, with Request for an app not set up.">
        <TeamAppsSection workspaces={TEAM_WS} initial={MEMBER} />
      </SettingsPage>
      <SettingsPage title="Connected apps: an agent" description="Fixture: an agent connection open, one workspace out of reach.">
        <ConnectionsSection api={localApi} now={NOW} initiallyOpen={AGENT.id} initial={data({ connections: [AGENT] })} />
      </SettingsPage>
      <SettingsPage title="Connected apps: adding workspaces" description="Fixture: the picker as Add or remove opens it.">
        <div className="border-y border-border-default py-4">
          <WorkspacePicker teams={TEAMS} clientName="Claude Code" initialSelected={PERSON.workspaces.map((w) => w.id)} onCancel={() => {}} onSave={() => {}} />
        </div>
      </SettingsPage>
      <SettingsPage title="Connected apps: none" description="Fixture: nothing connected.">
        <ConnectionsSection api={localApi} now={NOW} initial={data({ connections: [] })} />
      </SettingsPage>
    </div>
  );
}
