import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Invariant: an API-key caller may act only on workspaces of its key's team;
 * a session caller only on workspaces of a team it belongs to. Inaccessible
 * workspaces are 404, never 403. Writes keep their owner/admin bar (session
 * role, or an admin-level key).
 *
 * The db is an in-memory fixture that EVALUATES each rendered WHERE clause
 * (PgDialect) against its rows, and team-access is the real module. A route
 * that skipped the team comparison, or an access helper that ignored a
 * predicate, therefore changes the answer here — which a mocked `findFirst`
 * returning one canned row would hide.
 */

type Row = Record<string, any>;

const installation = { id: 'inst-row', installationId: 1, accountLogin: 'acme', accountType: 'Organization' };
const repo = { id: 'repo-row', fullName: 'acme/app', installation };

const tables: Record<string, Row[]> = {
  workspaces: [
    // Both workspaces are `open`: open must not widen access beyond the owning team.
    { id: 'ws-a', teamId: 'team-a', name: 'A', accessMode: 'open', gitConfig: {}, configStatus: 'unconfigured', githubRepo: repo, githubInstallationId: 'inst-row', githubInstallation: installation, workTrackerConfig: null },
    { id: 'ws-b', teamId: 'team-b', name: 'B', accessMode: 'open', gitConfig: {}, configStatus: 'unconfigured', githubRepo: repo, githubInstallationId: 'inst-row', githubInstallation: installation, workTrackerConfig: null },
  ],
  teamMembers: [
    { teamId: 'team-a', userId: 'user-a-admin', role: 'admin' },
    { teamId: 'team-b', userId: 'user-b-admin', role: 'admin' },
    { teamId: 'team-b', userId: 'user-b-member', role: 'member' },
  ],
  accounts: [
    { id: 'acct-a-admin', teamId: 'team-a' },
    { id: 'acct-a-worker', teamId: 'team-a' },
    { id: 'acct-a-linked', teamId: 'team-a' },
  ],
  // An explicit grant: a team A runner account linked to run workers in ws-b.
  accountWorkspaces: [{ accountId: 'acct-a-linked', workspaceId: 'ws-b', canClaim: true, canCreate: false }],
  teams: [],
  tasks: [],
  githubInstallations: [installation],
};

const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Rows of `table` satisfying a WHERE built only from `=` / `is not null` conjuncts. Anything else throws. */
function evaluate(table: string, where: unknown): Row[] {
  const rows = tables[table] ?? [];
  if (!where) return rows;
  const { sql, params } = dialect.sqlToQuery(where as any);
  const conds: Array<(r: Row) => boolean> = [];
  const rest = sql
    .replace(/"(\w+)"\."(\w+)" = \$(\d+)/g, (_m, _t, col, n) => {
      const value = params[Number(n) - 1];
      conds.push(r => r[camel(col)] === value);
      return '';
    })
    .replace(/"(\w+)"\."(\w+)" is not null/g, (_m, _t, col) => {
      conds.push(r => r[camel(col)] != null);
      return '';
    });
  if (rest.replace(/[()\s]|and/g, '') !== '') {
    throw new Error(`fixture db cannot evaluate predicate: ${sql}`);
  }
  return rows.filter(r => conds.every(c => c(r)));
}

const queryProxy = new Proxy({}, {
  get: (_t, table: string) => ({
    findFirst: async (opts: any = {}) => evaluate(table, opts.where)[0] ?? null,
    findMany: async (opts: any = {}) => evaluate(table, opts.where),
  }),
});

const writes: string[] = [];
const chain = (): any => {
  const c: any = {
    set: () => c, values: () => c, where: () => c, onConflictDoUpdate: () => c,
    returning: () => Promise.resolve([{ id: 'row' }]),
    then: (res: any, rej: any) => Promise.resolve(undefined).then(res, rej),
  };
  return c;
};

mock.module('@buildd/core/db', () => ({
  db: {
    query: queryProxy,
    update: () => { writes.push('update'); return chain(); },
    insert: () => { writes.push('insert'); return chain(); },
  },
}));

let currentUser: { id: string } | null = null;
let currentKey: { id: string; teamId: string; level: string } | null = null;

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => currentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => currentKey }));
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: () => true,
  githubApi: async (_inst: number, path: string) => {
    if (path.includes('/git/trees/')) return { tree: [{ path: 'src/index.ts', type: 'blob' }] };
    return {
      id: 9, full_name: 'acme/new', name: 'new', owner: { login: 'acme' }, private: true,
      default_branch: 'main', html_url: 'https://github.com/acme/new', description: null,
    };
  },
}));

const policyInit = await import('./policy-init/route');
const config = await import('./config/route');
const settings = await import('./settings/route');
const lastRelease = await import('./last-release/route');
const createRepo = await import('./create-repo/route');

const originalNodeEnv = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = 'production'; });
afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

const KEYS = {
  aAdmin: { id: 'acct-a-admin', teamId: 'team-a', level: 'admin' },
  aWorker: { id: 'acct-a-worker', teamId: 'team-a', level: 'worker' },
};

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type RouteCase = { name: string; handler: Handler; method: string; path: string; body?: unknown; write: boolean };

const policyConfig = { preset: 'balanced', riskClasses: [] };

const ROUTES: RouteCase[] = [
  { name: 'POST policy-init', handler: policyInit.POST, method: 'POST', path: 'policy-init', body: { preset: 'balanced' }, write: false },
  { name: 'GET config', handler: config.GET, method: 'GET', path: 'config', write: false },
  { name: 'POST config', handler: config.POST, method: 'POST', path: 'config', body: { releaseConfig: null }, write: true },
  { name: 'PATCH config', handler: config.PATCH, method: 'PATCH', path: 'config', body: { policyConfig }, write: true },
  { name: 'GET settings', handler: settings.GET, method: 'GET', path: 'settings', write: false },
  { name: 'PATCH settings', handler: settings.PATCH, method: 'PATCH', path: 'settings', body: { workTrackerConfig: null }, write: true },
  { name: 'GET last-release', handler: lastRelease.GET, method: 'GET', path: 'last-release', write: false },
  { name: 'POST create-repo', handler: createRepo.POST, method: 'POST', path: 'create-repo', body: { name: 'new' }, write: true },
];

/** Writes that need an admin-level key. */
const KEY_ADMIN_WRITES = new Set(['POST config', 'PATCH config', 'POST create-repo']);
/** Writes that need a session owner/admin (not bare membership). */
const SESSION_ADMIN_WRITES = new Set(['POST config', 'PATCH config']);

async function call(route: RouteCase, workspaceId: string, as: { key?: typeof currentKey; user?: typeof currentUser }) {
  currentKey = as.key ?? null;
  currentUser = as.user ?? null;
  const headers: Record<string, string> = {};
  if (currentKey) headers.Authorization = 'Bearer bld_fixture';
  const req = new NextRequest(`http://localhost/api/workspaces/${workspaceId}/${route.path}`, {
    method: route.method,
    headers,
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  });
  return route.handler(req, { params: Promise.resolve({ id: workspaceId }) });
}

for (const route of ROUTES) {
  describe(`${route.name} is scoped to the caller's team`, () => {
    it('an admin key of team A gets 404 on a team B workspace (even when open)', async () => {
      writes.length = 0;
      const res = await call(route, 'ws-b', { key: KEYS.aAdmin });
      expect(res.status).toBe(404);
      expect(writes).toEqual([]);
    });

    it('an admin key of team A gets 200 on its own workspace', async () => {
      const res = await call(route, 'ws-a', { key: KEYS.aAdmin });
      expect(res.status).toBe(200);
    });

    it('a session admin of team B gets 200 on the team B workspace', async () => {
      const res = await call(route, 'ws-b', { user: { id: 'user-b-admin' } });
      expect(res.status).toBe(200);
    });

    it('a session admin of team A gets 404 on the team B workspace', async () => {
      writes.length = 0;
      const res = await call(route, 'ws-b', { user: { id: 'user-a-admin' } });
      expect(res.status).toBe(404);
      expect(writes).toEqual([]);
    });

    it('an unknown workspace is 404 for a key', async () => {
      const res = await call(route, 'ws-missing', { key: KEYS.aAdmin });
      expect(res.status).toBe(404);
    });

    if (KEY_ADMIN_WRITES.has(route.name)) {
      it('a worker-level key of the same team is rejected for the write', async () => {
        writes.length = 0;
        const res = await call(route, 'ws-a', { key: KEYS.aWorker });
        expect(res.status).toBe(403);
        expect(writes).toEqual([]);
      });

      it('a worker-level key of another team still gets 404, not 403', async () => {
        const res = await call(route, 'ws-b', { key: KEYS.aWorker });
        expect(res.status).toBe(404);
      });
    } else if (!route.write) {
      it('a worker-level key of the same team may read', async () => {
        const res = await call(route, 'ws-a', { key: KEYS.aWorker });
        expect(res.status).toBe(200);
      });
    }

    if (SESSION_ADMIN_WRITES.has(route.name)) {
      it('a session member (not admin) of the team is rejected for the write', async () => {
        writes.length = 0;
        const res = await call(route, 'ws-b', { user: { id: 'user-b-member' } });
        expect(res.status).toBe(403);
        expect(writes).toEqual([]);
      });
    }
  });
}

describe('GET config with a Bearer header', () => {
  it('rejects a Bearer token that authenticates no account', async () => {
    const req = new NextRequest('http://localhost/api/workspaces/ws-a/config', {
      headers: { Authorization: 'Bearer not-a-key' },
    });
    currentKey = null;
    currentUser = null;
    const res = await config.GET(req, { params: Promise.resolve({ id: 'ws-a' }) });
    expect(res.status).toBe(401);
  });
});

describe('an explicit accountWorkspaces link', () => {
  const linked = { id: 'acct-a-linked', teamId: 'team-a', level: 'worker' };

  it('lets a linked runner key read the config of the linked workspace', async () => {
    const route = ROUTES.find(r => r.name === 'GET config')!;
    const res = await call(route, 'ws-b', { key: linked });
    expect(res.status).toBe(200);
  });

  it('grants nothing beyond that read', async () => {
    for (const route of ROUTES.filter(r => r.name !== 'GET config')) {
      const res = await call(route, 'ws-b', { key: linked });
      expect({ route: route.name, status: res.status }).toEqual({ route: route.name, status: 404 });
    }
  });
});
