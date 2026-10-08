import { describe, it, expect } from 'bun:test';
import {
  parseCapability,
  resolveCapability,
  listCapabilities,
  type DiscoveryInput,
  type DiscoveryConnector,
} from './capability-discovery';
import { CONNECTOR_CATALOG, type ResolvedCatalogEntry, type CatalogPolicy } from './connector-catalog';

const NOW = new Date('2026-10-08T12:00:00Z');
const HOUR = 3_600_000;
const TEAM = 'team-a';

function catalog(policies: Record<string, CatalogPolicy> = {}): ResolvedCatalogEntry[] {
  return CONNECTOR_CATALOG.map(e => ({ ...e, id: null, source: 'builtin' as const, policy: policies[e.slug] ?? 'available' }));
}

const axiom: DiscoveryConnector = {
  id: 'c-axiom', name: 'axiom', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', transport: 'http', command: null, ownerTeamId: TEAM,
};
const vercel: DiscoveryConnector = {
  id: 'c-vercel', name: 'vercel', url: 'https://mcp.vercel.com', authMode: 'oauth', transport: 'http', command: null, ownerTeamId: TEAM,
};

function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    teamId: TEAM,
    catalog: catalog(),
    connectors: [axiom, vercel],
    workspaceEnablement: new Map([['c-axiom', true], ['c-vercel', true]]),
    credentials: new Map([
      ['c-axiom', { tokenExpiresAt: new Date(NOW.getTime() + HOUR), lastVerificationError: null, healthStatus: 'healthy' }],
      ['c-vercel', { tokenExpiresAt: new Date(NOW.getTime() + HOUR), lastVerificationError: null, healthStatus: 'healthy' }],
    ]),
    roles: [
      { slug: 'builder', connectorRefs: ['c-axiom', 'c-vercel'], allowedTools: [] },
      { slug: 'researcher', connectorRefs: [], allowedTools: [] },
    ],
    roleSlug: null,
    operatorGrant: null,
    now: NOW,
    ...over,
  };
}

const axiomOf = (r: ReturnType<typeof resolveCapability>) => ok(r).candidates.find(c => c.provider.slug === 'axiom')!;

const ok = (r: ReturnType<typeof resolveCapability>) => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('parseCapability', () => {
  it('accepts domain:verb from the small vocabulary', () => {
    expect(parseCapability('observability:query')).toEqual({ domain: 'observability', verb: 'query' });
    expect(parseCapability(' Deployment:Read ')).toEqual({ domain: 'deployment', verb: 'read' });
  });
  it('reads a bare domain as read', () => {
    expect(parseCapability('observability')).toEqual({ domain: 'observability', verb: 'read' });
  });
  it('rejects anything outside it rather than guessing', () => {
    expect(parseCapability('observability:admin')).toBeNull();
    expect(parseCapability('telemetry:read')).toBeNull();
    expect(parseCapability('')).toBeNull();
  });
});

describe('resolveCapability: Axiom query vs Vercel logs', () => {
  it('ranks Axiom as the exact, available match for observability:query and Vercel as partial', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'observability:query'));
    expect(r.candidates.map(c => c.provider.slug)).toEqual(['axiom', 'vercel', 'sentry']);
    const [ax, ve] = r.candidates;
    expect(ax.match).toBe('exact');
    expect(ax.access).toBe('permitted');
    expect(ax.availableNow).toBe(true);
    expect(ve.match).toBe('partial');
    expect(ve.matchNote).toMatch(/logs/i);
  });

  it('serves deployment:read from Vercel, with Axiom absent', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'deployment:read'));
    expect(r.candidates.map(c => c.provider.slug)).toEqual(['vercel']);
  });

  it('a read-only provider never matches a write need', () => {
    const r = ok(resolveCapability(input(), 'observability:write'));
    expect(r.candidates.find(c => c.provider.slug === 'axiom')).toBeUndefined();
  });
});

describe('resolveCapability: provider compatibility and risk', () => {
  it('Vercel is permitted but not available: client approval is unknown until tested', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'deployment:read'));
    const ve = r.candidates[0];
    expect(ve.access).toBe('permitted');
    expect(ve.compatibility.status).toBe('unknown_until_tested');
    expect(ve.availableNow).toBe(false);
    expect(ve.reasons).toContain('provider_compatibility_unknown');
  });

  it('a read need on a read/write provider says every native tool, writes included, is exposed', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'deployment:read'));
    expect(r.candidates[0].risk).toMatchObject({ requested: 'read', writeToolsExposed: true });
    expect(r.candidates[0].risk.note).toMatch(/does not narrow/i);
  });

  it('a write need is reported as write risk', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'deployment:write'));
    expect(r.candidates[0].risk.requested).toBe('write');
  });

  it('Axiom read is reported as a read-only tool surface', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'builder' }), 'observability:query'));
    expect(r.candidates[0].risk.writeToolsExposed).toBe(false);
  });

  it('role allowedTools that name native tools are reported as a narrowing, tool names untouched', () => {
    const roles = [{ slug: 'builder', connectorRefs: ['c-vercel'], allowedTools: ['Read', 'mcp__vercel__get_deployment'] }];
    const r = ok(resolveCapability(input({ roles, roleSlug: 'builder' }), 'deployment:read'));
    expect(r.candidates[0].roles.nativeToolsListed).toEqual(['mcp__vercel__get_deployment']);
  });
});

describe('resolveCapability: missing connection', () => {
  it('a catalog provider nobody installed is ask_admin with an install step', () => {
    const r = ok(resolveCapability(input({ connectors: [vercel], roleSlug: 'builder' }), 'observability:query'));
    const ax = r.candidates.find(c => c.provider.slug === 'axiom')!;
    expect(ax.connector).toBeNull();
    expect(ax.access).toBe('ask_admin');
    expect(ax.availableNow).toBe(false);
    expect(ax.reasons).toContain('not_installed');
  });

  it('an installed OAuth connector that was never connected is reconnect, not available', () => {
    const credentials = new Map(input().credentials);
    credentials.delete('c-axiom');
    const ax = axiomOf(resolveCapability(input({ credentials, roleSlug: 'builder' }), 'observability:query'));
    expect(ax.health).toBe('not_connected');
    expect(ax.access).toBe('reconnect');
    expect(ax.availableNow).toBe(false);
  });

  it('a connector disabled in this workspace is ask_admin', () => {
    const workspaceEnablement = new Map([['c-axiom', false], ['c-vercel', true]]);
    const r = ok(resolveCapability(input({ workspaceEnablement, roleSlug: 'builder' }), 'observability:query'));
    const ax = r.candidates.find(c => c.provider.slug === 'axiom')!;
    expect(ax.workspace).toBe('disabled');
    expect(ax.access).toBe('ask_admin');
    expect(ax.availableNow).toBe(false);
  });
});

describe('resolveCapability: expired OAuth', () => {
  it('past the refresh grace it is reconnect', () => {
    const credentials = new Map(input().credentials);
    credentials.set('c-axiom', { tokenExpiresAt: new Date(NOW.getTime() - 48 * HOUR), lastVerificationError: null, healthStatus: 'healthy' });
    const ax = axiomOf(resolveCapability(input({ credentials, roleSlug: 'builder' }), 'observability:query'));
    expect(ax.access).toBe('reconnect');
    expect(ax.availableNow).toBe(false);
  });

  it('a failed refresh is reconnect', () => {
    const credentials = new Map(input().credentials);
    credentials.set('c-axiom', { tokenExpiresAt: null, lastVerificationError: 'invalid_grant', healthStatus: 'unknown' });
    const ax = axiomOf(resolveCapability(input({ credentials, roleSlug: 'builder' }), 'observability:query'));
    expect(ax.health).toBe('needs_reconnect');
    expect(ax.access).toBe('reconnect');
  });

  it('just expired is never reported available: the refresh has not happened yet', () => {
    const credentials = new Map(input().credentials);
    credentials.set('c-axiom', { tokenExpiresAt: new Date(NOW.getTime() - 1000), lastVerificationError: null, healthStatus: 'healthy' });
    const ax = axiomOf(resolveCapability(input({ credentials, roleSlug: 'builder' }), 'observability:query'));
    expect(ax.health).toBe('expired');
    expect(ax.availableNow).toBe(false);
    expect(ax.reasons).toContain('token_refresh_pending');
  });

  it('a revoked credential is reconnect and a degraded one unhealthy', () => {
    const revoked = new Map(input().credentials);
    revoked.set('c-axiom', { tokenExpiresAt: new Date(NOW.getTime() + HOUR), lastVerificationError: null, healthStatus: 'revoked' });
    expect(axiomOf(resolveCapability(input({ credentials: revoked }), 'observability:query')).access).toBe('reconnect');
    const degraded = new Map(input().credentials);
    degraded.set('c-axiom', { tokenExpiresAt: new Date(NOW.getTime() + HOUR), lastVerificationError: null, healthStatus: 'degraded' });
    expect(axiomOf(resolveCapability(input({ credentials: degraded }), 'observability:query')).access).toBe('unhealthy');
  });
});

describe('resolveCapability: role filters', () => {
  it('a role that does not mount the connector, when another role does, is auto_grant via that role', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'researcher' }), 'observability:query'));
    const ax = r.candidates[0];
    expect(ax.access).toBe('auto_grant');
    expect(ax.availableNow).toBe(false);
    expect(ax.roles.evaluated).toEqual({ slug: 'researcher', mounts: false });
    expect(ax.roles.withAccess).toEqual(['builder']);
    expect(ax.reasons).toContain('role_lacks_connector');
  });

  it('when no role mounts it, it is ask_admin', () => {
    const roles = [{ slug: 'researcher', connectorRefs: [], allowedTools: [] }];
    const ax = ok(resolveCapability(input({ roles, roleSlug: 'researcher' }), 'observability:query')).candidates[0];
    expect(ax.access).toBe('ask_admin');
    expect(ax.roles.withAccess).toEqual([]);
  });

  it('an unknown role is reported, not treated as having access', () => {
    const r = ok(resolveCapability(input({ roleSlug: 'ghost' }), 'observability:query'));
    expect(r.role).toEqual({ slug: 'ghost', found: false });
    expect(r.candidates.some(c => c.access === 'permitted')).toBe(false);
    expect(r.candidates[0].reasons).toContain('role_not_found');
  });

  it('without a role, any role that mounts it makes it permitted', () => {
    const ax = ok(resolveCapability(input(), 'observability:query')).candidates[0];
    expect(ax.access).toBe('permitted');
    expect(ax.roles.evaluated).toBeNull();
    expect(ax.roles.withAccess).toEqual(['builder']);
  });
});

describe('resolveCapability: blocked catalog', () => {
  it('a blocked provider, installed or not, is forbidden and never available', () => {
    const r = ok(resolveCapability(input({ catalog: catalog({ axiom: 'blocked', sentry: 'blocked' }), roleSlug: 'builder' }), 'observability:query'));
    const ax = r.candidates.find(c => c.provider.slug === 'axiom')!;
    expect(ax.access).toBe('forbidden');
    expect(ax.availableNow).toBe(false);
    expect(r.candidates.find(c => c.provider.slug === 'sentry')!.access).toBe('forbidden');
    // forbidden sorts last
    expect(r.candidates.at(-1)!.access).toBe('forbidden');
  });
});

describe('resolveCapability: empty alternatives', () => {
  it('returns no candidates and says so when nothing serves the need', () => {
    const r = ok(resolveCapability(input({ catalog: [], connectors: [] }), 'observability:query'));
    expect(r.candidates).toEqual([]);
    expect(r.summary).toMatch(/nothing/i);
  });

  it('rejects an unknown capability with the vocabulary', () => {
    const r = resolveCapability(input(), 'telemetry:read');
    expect('error' in r && r.error).toMatch(/observability/);
  });
});

describe('resolveCapability: team scoping', () => {
  it('a shared-in connector is labelled shared and carries no owner team', () => {
    const shared = { ...axiom, ownerTeamId: 'team-b' };
    const ax = ok(resolveCapability(input({ connectors: [shared, vercel] }), 'observability:query')).candidates[0];
    expect(ax.connector?.ownership).toBe('shared');
    expect(JSON.stringify(ax)).not.toContain('team-b');
  });

  it('a connector with no catalog match is listed as unclassified, not guessed', () => {
    const custom = { id: 'c-x', name: 'internal-logs', url: 'https://logs.example.com/mcp', authMode: 'none' as const, transport: 'http' as const, command: null, ownerTeamId: TEAM };
    const r = ok(resolveCapability(input({ connectors: [custom] }), 'observability:query'));
    expect(r.unclassifiedConnectors).toEqual([{ id: 'c-x', name: 'internal-logs' }]);
  });

  it('a team catalog entry of an observability category matches by category', () => {
    const teamEntry: ResolvedCatalogEntry = {
      id: 'e1', source: 'team', policy: 'available', slug: 'grafana', name: 'Grafana', url: 'https://grafana.example.com/mcp',
      authMode: 'header', description: '', category: 'observability', iconUrl: '',
    };
    const r = ok(resolveCapability(input({ catalog: [teamEntry], connectors: [] }), 'observability:query'));
    expect(r.candidates[0]).toMatchObject({ match: 'category', access: 'ask_admin' });
    expect(r.candidates[0].risk.writeToolsExposed).toBe('unknown');
  });
});

describe('resolveCapability: runtime needs stay separate', () => {
  it('a stdio connector reports its binary as a runtime need and is not checked for health', () => {
    const stdio = { id: 'c-s', name: 'sentry', url: 'https://mcp.sentry.dev/mcp', authMode: 'none' as const, transport: 'stdio' as const, command: 'npx', ownerTeamId: TEAM };
    const roles = [{ slug: 'builder', connectorRefs: ['c-s'], allowedTools: [] }];
    const s = ok(resolveCapability(input({ connectors: [stdio], roles, workspaceEnablement: new Map() }), 'observability:read'))
      .candidates.find(c => c.connector?.id === 'c-s')!;
    expect(s.runtimeNeeds).toEqual([{ kind: 'binary', name: 'npx' }]);
    expect(s.health).toBe('unchecked');
    expect(s.workspace).toBe('default_enabled');
    expect(s.availableNow).toBe(false);
  });
});

describe('resolveCapability: operator path', () => {
  it('reports the role\'s Operator deployment grant beside the connectors', () => {
    const r = ok(resolveCapability(input({
      roleSlug: 'operator',
      operatorGrant: { roleSlug: 'operator', enabled: true, capabilities: ['deployments:read'], providers: ['vercel'] },
    }), 'deployment:read'));
    expect(r.operator).toEqual({ capability: 'deployments:read', role: 'operator', granted: true, providers: ['vercel'] });
    const w = ok(resolveCapability(input({
      roleSlug: 'operator',
      operatorGrant: { roleSlug: 'operator', enabled: true, capabilities: ['deployments:read'], providers: ['vercel'] },
    }), 'deployment:write'));
    expect(w.operator?.granted).toBe(false);
  });

  it('has no operator path outside deployment', () => {
    expect(ok(resolveCapability(input(), 'observability:query')).operator).toBeNull();
  });
});

describe('listCapabilities', () => {
  it('lists only needs something serves, with what is available now', () => {
    const list = listCapabilities(input({ roleSlug: 'builder' }));
    const q = list.capabilities.find(c => c.capability === 'observability:query')!;
    expect(q.availableNow).toEqual(['axiom']);
    expect(q.candidates).toBeGreaterThanOrEqual(2);
    expect(list.capabilities.find(c => c.capability === 'source_control:write')).toBeUndefined();
  });
});
