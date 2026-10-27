'use client';

/**
 * `?state=mcp-connections`: Settings → Connected apps with fake data and a
 * local api (nothing is sent anywhere; edits apply to an in-memory model).
 * Sections, top to bottom: the page as a team admin sees it (your apps with an
 * "acts as you" connection open: one team on all current and future
 * workspaces, one on specific workspaces; older connections folded; team apps
 * with one open); team apps as a member sees them; an agent connection open,
 * with a workspace out of reach; a team's access editor switching from all to
 * specific workspaces on a large team; a save that met a newer change; no
 * connections.
 */
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import ConnectionsSection, { type ConnectionsApi, type ConnectionsData, type PatchBody } from '../../(protected)/settings/connections/ConnectionsSection';
import TeamAccessEditor from '../../(protected)/settings/connections/TeamAccessEditor';
import TeamAppsSection, { type TeamAppsData } from '../../(protected)/settings/connections/connectors/TeamAppsSection';
import { CONNECTOR_CATALOG, customerCatalogEntry } from '@/lib/connector-catalog';
import type { ConnectionSummary, ConnectionTeam, ConnectionWorkspace } from '@/lib/mcp-grant-patch';
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

/** What a fixture connection covers: whole teams, and workspaces one by one. */
type Rows = { whole: string[]; specific: string[] };

/** The summary the API would return for these rows (same shape, same order). */
function summary(base: Omit<ConnectionSummary, 'workspaces' | 'teams' | 'unreachableTeamCount'>, rows: Rows): ConnectionSummary {
  const reached = new Map<string, ConnectionWorkspace>();
  for (const t of TEAMS) {
    t.workspaces.forEach((w, i) => {
      if (rows.whole.includes(t.id) || rows.specific.includes(w.id)) reached.set(w.id, ws(t, i));
    });
  }
  const flat = [...reached.values()].sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name));
  const teams: ConnectionTeam[] = [];
  for (const t of TEAMS) {
    const here = flat.filter((w) => w.teamId === t.id);
    if (rows.whole.includes(t.id)) teams.push({ teamId: t.id, teamName: t.name, mode: 'all', workspaces: here });
    else if (here.length > 0) teams.push({ teamId: t.id, teamName: t.name, mode: 'specific', workspaces: here });
  }
  return { ...base, workspaces: flat, teams, unreachableTeamCount: 0 };
}

const PERSON_BASE = {
  id: 'fixture-person', clientName: 'Claude Code', actsAs: 'person' as const, access: 'read-write' as const,
  createdAt: '2026-09-20T09:00:00Z', lastActiveAt: '2026-10-09T10:40:00Z', expiresAt: null, unreachableCount: 0, revision: 3,
};
const AGENT_BASE = {
  id: 'fixture-agent', clientName: 'Team connector', actsAs: 'agent' as const, access: 'read' as const,
  createdAt: '2026-09-02T09:00:00Z', lastActiveAt: '2026-10-06T08:00:00Z', expiresAt: null, unreachableCount: 1, revision: 1,
};
const PERSON_ROWS: Rows = { whole: ['team-a'], specific: [TEAMS[1].workspaces[1].id] };
const AGENT_ROWS: Rows = { whole: [], specific: [TEAMS[0].workspaces[4].id] };
const PERSON = summary(PERSON_BASE, PERSON_ROWS);
const AGENT = summary(AGENT_BASE, AGENT_ROWS);

/** Apply a PATCH body to fixture rows the way the server would. */
function applyPatch(rows: Rows, body: PatchBody): Rows {
  const whole = new Set(rows.whole);
  const specific = new Set(rows.specific);
  for (const t of body.teams ?? []) {
    const team = TEAMS.find((x) => x.id === t.teamId)!;
    if (t.mode === 'all') { whole.add(t.teamId); continue; }
    whole.delete(t.teamId);
    for (const w of team.workspaces) specific.delete(w.id);
    if (t.mode === 'specific') for (const id of t.workspaceIds) specific.add(id);
  }
  for (const id of body.addWorkspaceIds ?? []) specific.add(id);
  for (const id of body.removeWorkspaceIds ?? []) specific.delete(id);
  return { whole: [...whole], specific: [...specific] };
}

function localApi(): ConnectionsApi {
  const state: Record<string, { base: typeof PERSON_BASE | typeof AGENT_BASE; rows: Rows }> = {
    [PERSON.id]: { base: { ...PERSON_BASE }, rows: PERSON_ROWS },
    [AGENT.id]: { base: { ...AGENT_BASE }, rows: AGENT_ROWS },
  };
  return {
    async patch(id, body) {
      const s = state[id];
      s.rows = applyPatch(s.rows, body);
      s.base = { ...s.base, ...(body.access ? { access: body.access } : {}), ...(body.actsAs ? { actsAs: body.actsAs } : {}), revision: s.base.revision + 1 } as typeof s.base;
      return { ok: true, connection: summary(s.base, s.rows) };
    },
    async revoke() { return { ok: true }; },
  };
}

/** Every save meets a newer change made elsewhere, as when another tab saved first. */
const staleApi: ConnectionsApi = {
  async patch() {
    return {
      ok: false,
      code: 'stale_connection',
      error: 'This connection changed since you opened it. Review what it has now and make your change again.',
      connection: summary({ ...PERSON_BASE, revision: PERSON_BASE.revision + 1 }, { whole: ['team-a'], specific: [] }),
    };
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
          api={localApi()}
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
        <ConnectionsSection api={localApi()} now={NOW} initiallyOpen={AGENT.id} initial={data({ connections: [AGENT] })} />
      </SettingsPage>
      <SettingsPage title="Connected apps: switching to specific workspaces" description="Fixture: a team on all workspaces, its editor on Specific workspaces, prefilled with what it reaches now.">
        <div className="border-y border-border-default py-4" data-testid="fixture-team-editor">
          <TeamAccessEditor connection={PERSON} team={TEAMS[0]} initialChoice="specific" saving={false} error={null} onCancel={() => {}} onSave={() => {}} />
        </div>
      </SettingsPage>
      <SettingsPage title="Connected apps: a newer change" description="Fixture: Save met a change made in another tab; the page shows the connection as it is now.">
        <div className="border-y border-border-default py-4">
          <TeamAccessEditor
            connection={PERSON}
            team={TEAMS[1]}
            initialChoice="all"
            saving={false}
            error="This connection changed since you opened it. Review what it has now and make your change again."
            onCancel={() => {}}
            onSave={() => {}}
          />
        </div>
        <ConnectionsSection api={staleApi} now={NOW} initial={data({ connections: [PERSON] })} />
      </SettingsPage>
      <SettingsPage title="Connected apps: none" description="Fixture: nothing connected.">
        <ConnectionsSection api={localApi()} now={NOW} initial={data({ connections: [] })} />
      </SettingsPage>
    </div>
  );
}
