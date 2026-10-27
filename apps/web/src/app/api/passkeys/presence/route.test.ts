/**
 * The passkey endpoints (Living Spec b7fc9316 R-20) are a person's, in their
 * own browser: the real dashboardCaller refuses any request that carries an
 * Authorization header, cookie or not, so no token (an OAuth session, an API
 * key, a task token) asks for a challenge, registers a passkey, removes one
 * or flips the team switch. The passkey store itself is real-Postgres tested
 * in tests/db/spec-passkey-presence.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let user: { id: string } | null = { id: 'u1' };
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/task-token-auth', () => ({ authenticateTaskScopedCaller: async () => null }));
const seen: Array<[string, unknown[]]> = [];
const record = (name: string, reply: unknown) => async (...args: unknown[]) => { seen.push([name, args]); return reply; };
mock.module('@/lib/passkeys/guard', () => ({
  issuePresenceChallenge: record('issuePresenceChallenge', { ok: true, options: { challenge: 'c' } }),
  issueRegistrationChallenge: record('issueRegistrationChallenge', { ok: true, options: { challenge: 'r' } }),
  registerPasskey: record('registerPasskey', { ok: false, status: 403, code: 'presence_required', error: 'needs one', presence: { pin: { op: 'add_passkey' }, addUrl: 'x' } }),
  removePasskey: record('removePasskey', { ok: true }),
  listPasskeys: record('listPasskeys', []),
  setTeamPasskeyRequired: record('setTeamPasskeyRequired', { ok: true, required: true }),
}));

const presence = await import('./route');
const register = await import('../register/route');
const registerOptions = await import('../register/options/route');
const list = await import('../route');
const remove = await import('../[id]/route');
const teamSwitch = await import('../../teams/[id]/spec-passkey/route');

const PIN = { op: 'approve', specId: '11111111-1111-4111-8111-111111111111', revision: 2, version: 3, contentHash: 'a'.repeat(64) };
const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://l${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers });
const id = { params: Promise.resolve({ id: '55555555-5555-4555-8555-555555555555' }) };

const calls = () => [
  () => presence.POST(req('/api/passkeys/presence', 'POST', { pin: PIN })),
  () => registerOptions.POST(req('/api/passkeys/register/options', 'POST')),
  () => register.POST(req('/api/passkeys/register', 'POST', { response: {} })),
  () => list.GET(req('/api/passkeys', 'GET')),
  () => remove.DELETE(req('/api/passkeys/x', 'DELETE', {}), id),
  () => teamSwitch.PUT(req('/api/teams/x/spec-passkey', 'PUT', { required: true }), id),
];

describe('passkey endpoints', () => {
  it('any bearer is a 403 and the store is never reached, cookie or not', async () => {
    user = { id: 'u1' };
    const before = seen.length;
    const routes = [
      (h: Record<string, string>) => presence.POST(req('/api/passkeys/presence', 'POST', { pin: PIN }, h)),
      (h: Record<string, string>) => registerOptions.POST(req('/api/passkeys/register/options', 'POST', undefined, h)),
      (h: Record<string, string>) => register.POST(req('/api/passkeys/register', 'POST', { response: {} }, h)),
      (h: Record<string, string>) => list.GET(req('/api/passkeys', 'GET', undefined, h)),
      (h: Record<string, string>) => remove.DELETE(req('/api/passkeys/x', 'DELETE', {}, h), id),
      (h: Record<string, string>) => teamSwitch.PUT(req('/api/teams/x/spec-passkey', 'PUT', { required: false }, h), id),
    ];
    for (const route of routes) {
      for (const token of ['oauth-session-token', 'bld_xxx', 'bldt_task']) {
        expect((await route({ authorization: `Bearer ${token}` })).status).toBe(403);
      }
    }
    expect(seen.length).toBe(before);
  });

  it('no session is a 401 on every one', async () => {
    user = null;
    for (const call of calls()) expect((await call()).status).toBe(401);
    user = { id: 'u1' };
  });

  it('a challenge is issued only for a pin that names a known act, to the signed-in person', async () => {
    user = { id: 'u1' };
    expect((await presence.POST(req('/api/passkeys/presence', 'POST', { pin: { op: 'anything' } }))).status).toBe(400);
    const res = await presence.POST(req('/api/passkeys/presence', 'POST', { pin: { ...PIN, extra: 1 } }));
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual(['issuePresenceChallenge', ['u1', PIN]]);
  });

  it('a refusal carries its code and the pin to ask a passkey for', async () => {
    const res = await register.POST(req('/api/passkeys/register', 'POST', { response: {}, name: 'Phone' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'presence_required', presence: { pin: { op: 'add_passkey' } } });
  });
});
