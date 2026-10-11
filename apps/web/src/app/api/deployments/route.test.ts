/**
 * POST /api/deployments — the human escape hatch: admin bld_ keys only, own
 * team's workspace only, audited as admin, and never returns the credential.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WS = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'cf_secret_token_value_not_real_00000000000';
const CF_ACCOUNT = 'fedcba9876543210fedcba9876543210';
const BODY = { workspaceId: WS, provider: 'cloudflare', project: 'buildd-cloud-runner', environment: 'production', credentialRef: 'cloudflare', operation: 'status' };

let authed: { id: string; teamId: string; level: string; scopes?: null } | null;
let workspace: Record<string, unknown> | null;
let audits: Array<Record<string, unknown>>;
let credentialReads: number;

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => authed }));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'workspaces.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: async () => workspace } } } }));
mock.module('@/lib/deployments/store', () => ({
  deploymentStore: {
    recordAudit: async (row: Record<string, unknown>) => { audits.push(row); return 'audit-1'; },
    settleAudit: async () => {},
    resolveCredential: async () => { credentialReads++; return { apiToken: TOKEN, accountId: CF_ACCOUNT }; },
  },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) =>
  new Response(JSON.stringify({ success: true, result: String(url).endsWith('/deployments') ? { deployments: [] } : [] }))) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

import { POST } from './route';

const req = (body: unknown = BODY, auth: string | null = 'Bearer bld_admin') =>
  new NextRequest('http://localhost/api/deployments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  authed = { id: 'acct-1', teamId: 'team-1', level: 'admin', scopes: null };
  workspace = { id: WS, teamId: 'team-1' };
  audits = [];
  credentialReads = 0;
});

describe('POST /api/deployments', () => {
  it('refuses a missing key and a non-bld_ bearer', async () => {
    expect((await POST(req(BODY, null))).status).toBe(401);
    expect((await POST(req(BODY, 'Bearer eyJhbGciOi.x.y'))).status).toBe(401);
    expect((await POST(req(BODY, 'Bearer bldt_payload.sig'))).status).toBe(401);
  });

  for (const level of ['worker', 'trigger']) {
    it(`refuses a ${level}-level key without reading the credential`, async () => {
      authed = { ...authed!, level };
      expect((await POST(req())).status).toBe(403);
      expect(credentialReads).toBe(0);
    });
  }

  it('404s another team\'s workspace', async () => {
    workspace = { id: WS, teamId: 'team-2' };
    expect((await POST(req())).status).toBe(404);
    expect(credentialReads).toBe(0);
  });

  it('runs for an admin key, audited as admin, with no credential in the reply', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CF_ACCOUNT);
    expect(audits[0]).toMatchObject({ principal: 'admin', accountId: 'acct-1', workspaceId: WS, teamId: 'team-1', project: 'buildd-cloud-runner' });
  });
});
