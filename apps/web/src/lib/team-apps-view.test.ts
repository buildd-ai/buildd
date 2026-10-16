import { describe, expect, it } from 'bun:test';
import { buildTeamApps, stepErrorText, teamAppState, workspaceSummary, type TeamConnector } from './team-apps-view';
import type { CustomerCatalogEntry } from './connector-catalog';

const entry = (slug: string, over: Partial<CustomerCatalogEntry> = {}): CustomerCatalogEntry => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), url: `https://mcp.${slug}.example/mcp`, authMode: 'oauth',
  description: `${slug} desc`, category: 'other', iconUrl: '', id: null, source: 'builtin', policy: 'available', ...over,
});
const conn = (id: string, url: string, over: Partial<TeamConnector> = {}): TeamConnector => ({
  id, name: id, url, authMode: 'oauth', status: 'connected', ...over,
});

describe('buildTeamApps', () => {
  it('joins a catalog entry with the connector on its host, and lists custom connectors after', () => {
    const apps = buildTeamApps(
      [entry('axiom'), entry('sentry')],
      [conn('a', 'https://mcp.axiom.example/sse'), conn('x', 'https://tools.internal.example/mcp')],
    );
    expect(apps.map(a => a.key)).toEqual(['axiom', 'sentry', 'connector:x']);
    expect(apps[0].connector?.id).toBe('a');
    expect(apps[1].connector).toBeNull();
  });

  it('prefers the team’s own connector over one shared in on the same host', () => {
    const apps = buildTeamApps([entry('axiom')], [
      conn('shared', 'https://mcp.axiom.example/mcp', { shared: true }),
      conn('own', 'https://mcp.axiom.example/mcp'),
    ]);
    expect(apps).toHaveLength(1);
    expect(apps[0].connector?.id).toBe('own');
  });

  it('puts an unavailable app the team has nothing for last', () => {
    const apps = buildTeamApps([entry('vercel', { unavailable: true }), entry('axiom')], [conn('x', 'https://x.example/mcp')]);
    expect(apps.map(a => a.key)).toEqual(['axiom', 'connector:x', 'vercel']);
  });
});

describe('teamAppState', () => {
  const one = (e: CustomerCatalogEntry, c: TeamConnector[] = []) => buildTeamApps([e], c)[0];

  it('admin: Connect for an app not set up; member: Request', () => {
    expect(teamAppState(one(entry('axiom')), true)).toMatchObject({ label: 'Not set up', action: { kind: 'install', label: 'Connect' } });
    expect(teamAppState(one(entry('context7', { authMode: 'none' })), true).action?.label).toBe('Add');
    expect(teamAppState(one(entry('axiom')), false)).toMatchObject({ label: 'Not set up', action: { kind: 'request', label: 'Request' } });
  });

  it('Connected with no action for anyone', () => {
    const app = one(entry('axiom'), [conn('a', 'https://mcp.axiom.example/mcp')]);
    expect(teamAppState(app, true)).toEqual({ label: 'Connected', tone: 'ok', action: null });
    expect(teamAppState(app, false).action).toBeNull();
  });

  it('Reconnect for an expired sign-in, only for an admin of the owning team', () => {
    const own = one(entry('axiom'), [conn('a', 'https://mcp.axiom.example/mcp', { status: 'expired' })]);
    expect(teamAppState(own, true)).toMatchObject({ label: 'Sign-in expired', tone: 'act', action: { kind: 'connect', label: 'Reconnect' } });
    expect(teamAppState(own, false).action).toBeNull();
    const shared = one(entry('axiom'), [conn('a', 'https://mcp.axiom.example/mcp', { status: 'expired', shared: true })]);
    expect(teamAppState(shared, true).action).toBeNull();
  });

  it('an unavailable provider reads Not available with no Connect, for admins and members alike', () => {
    const vercel = entry('vercel', { unavailable: true });
    expect(teamAppState(one(vercel), true)).toEqual({ label: 'Not available', tone: 'muted', action: null });
    expect(teamAppState(one(vercel, [conn('v', 'https://mcp.vercel.example/mcp', { status: 'not_connected' })]), true).action).toBeNull();
  });

  it('blocked reads as the team’s decision, with no step', () => {
    expect(teamAppState(one(entry('neon', { policy: 'blocked' })), true)).toEqual({ label: 'Blocked by your team', tone: 'muted', action: null });
    const blockedConn = buildTeamApps([], [conn('n', 'https://n.example/mcp', { blockedByPolicy: true })])[0];
    expect(teamAppState(blockedConn, true).label).toBe('Blocked by your team');
  });

  it('a header-auth connector without a key asks for one', () => {
    const app = buildTeamApps([], [conn('h', 'https://h.example/mcp', { authMode: 'header', status: 'not_connected' })])[0];
    expect(teamAppState(app, true)).toMatchObject({ label: 'Needs a key', action: { kind: 'set_key', label: 'Add key' } });
  });

  it('no status label promises a future: no "coming soon", no review wording', () => {
    const labels = [
      entry('a'), entry('b', { unavailable: true }), entry('c', { policy: 'blocked' }),
    ].flatMap(e => [true, false].map(m => teamAppState(one(e), m).label));
    for (const l of labels) expect(l).not.toMatch(/soon|review|approv|yet/i);
  });
});

describe('workspaceSummary', () => {
  it('reads as a count', () => {
    expect(workspaceSummary(0, 3)).toBe('No workspaces');
    expect(workspaceSummary(3, 3)).toBe('All workspaces');
    expect(workspaceSummary(2, 5)).toBe('2 of 5 workspaces');
  });
});

describe('stepErrorText', () => {
  it('shows a server message, never a bare code', () => {
    expect(stepErrorText('Axiom', { message: "Axiom isn't available to connect." })).toBe("Axiom isn't available to connect.");
    expect(stepErrorText('Axiom', {})).toBe("Couldn't connect Axiom. Try again.");
  });
});
