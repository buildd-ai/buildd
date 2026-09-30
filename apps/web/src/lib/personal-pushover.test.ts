import { describe, it, expect, mock, beforeEach } from 'bun:test';

const writes: Array<[string, unknown]> = [];
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({ set: (v: unknown) => ({ where: async () => { writes.push(['update', v]); } }) }),
    query: { secrets: { findFirst: async () => ({ id: 'k1', encryptedValue: 'enc:uAbcdefghijklmnopqrstuvwxyz0123', healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null }) } },
  },
}));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  getSecretsProvider: () => ({
    replaceScoped: async (value: string, meta: unknown) => { writes.push(['replaceScoped', { value, meta }]); return 'k1'; },
  }),
}));

const {
  sanitizePushoverUserKey, personalSenderToken, sendPushoverMessage, validatePushoverUser, setPersonalPushover, ownScope,
} = await import('./personal-pushover');
const { PgDialect } = await import('drizzle-orm/pg-core');

const KEY = 'uAbcdefghijklmnopqrstuvwxyz0123'.slice(0, 30);
const fakeFetch = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => { writes.length = 0; });

describe('personal Pushover key', () => {
  it('accepts a 30-character key, trims quotes, refuses anything else', () => {
    expect(sanitizePushoverUserKey(` "${KEY}" `)).toEqual({ ok: true, value: KEY });
    expect(sanitizePushoverUserKey('').ok).toBe(false);
    expect(sanitizePushoverUserKey('short').ok).toBe(false);
    expect(sanitizePushoverUserKey(`${KEY}!`).ok).toBe(false);
  });

  it('sends with the platform personal token, never a team row', () => {
    expect(personalSenderToken({ PUSHOVER_TOKEN_PERSONAL: 'p', PUSHOVER_TOKEN_TASK: 't' })).toBe('p');
    expect(personalSenderToken({ PUSHOVER_TOKEN_TASK: 't', PUSHOVER_TOKEN: 'x' })).toBe('t');
    expect(personalSenderToken({})).toBeNull();
  });

  it('classifies send outcomes', async () => {
    const m = { token: 't', user: KEY, title: 'x', message: 'y' };
    expect(await sendPushoverMessage(m, fakeFetch(200))).toBe('sent');
    expect(await sendPushoverMessage(m, fakeFetch(400))).toBe('rejected');
    expect(await sendPushoverMessage(m, fakeFetch(500))).toBe('failed');
    expect(await sendPushoverMessage(m, (async () => { throw new Error('net'); }) as unknown as typeof fetch)).toBe('failed');
  });

  it('an unstated priority is silent (-1), the same default every other sender uses', async () => {
    let body: { priority?: number } = {};
    const capture = (async (_u: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response('{}'); }) as unknown as typeof fetch;
    await sendPushoverMessage({ token: 't', user: KEY, title: 'x', message: 'y' }, capture);
    expect(body.priority).toBe(-1);
    await sendPushoverMessage({ token: 't', user: KEY, title: 'x', message: 'y', priority: 1 }, capture);
    expect(body.priority).toBe(1);
  });

  it('validate: 4xx is a rejected key, with Pushover\'s own reason', async () => {
    expect(await validatePushoverUser('t', KEY, fakeFetch(200, { status: 1 }))).toEqual({ health: 'healthy', error: null });
    const bad = await validatePushoverUser('t', KEY, fakeFetch(400, { status: 0, errors: ['user key is invalid'] }));
    expect(bad).toEqual({ health: 'revoked', error: 'Pushover: user key is invalid' });
  });

  it('a key Pushover rejects is never stored', async () => {
    const r = await setPersonalPushover({ userId: 'u-1', teamId: 't-1', value: KEY }, { token: 't', fetch: fakeFetch(400, { errors: ['user key is invalid'] }) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(writes).toEqual([]);
  });

  it('with no sender configured, saving is refused rather than storing a key nothing can use', async () => {
    const r = await setPersonalPushover({ userId: 'u-1', teamId: 't-1', value: KEY }, { token: null });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(writes).toEqual([]);
  });

  it("settings reads and writes are scoped to the caller's own personal row (rendered SQL)", () => {
    const q = new PgDialect().sqlToQuery(ownScope('u-1', 't-1')!);
    const t = q.sql.replace(/\s+/g, ' ');
    expect(t).toContain('"secrets"."team_id" = $1');
    expect(t).toContain('"secrets"."purpose" = $2');
    expect(t).toContain('"secrets"."user_id" = $3');
    expect(t).toContain('"secrets"."account_id" is null');
    expect(t).toContain('"secrets"."workspace_id" is null');
    expect(q.params).toEqual(['t-1', 'pushover_personal', 'u-1']);
    expect(t).not.toMatch(/\bor\b/i);
  });

  it('a good key is stored as the caller\'s personal row, purpose pushover_personal', async () => {
    const r = await setPersonalPushover({ userId: 'u-1', teamId: 't-1', value: KEY }, { token: 't', fetch: fakeFetch(200, { status: 1 }) });
    expect(r.ok).toBe(true);
    expect(writes[0]).toEqual(['replaceScoped', { value: KEY, meta: { teamId: 't-1', purpose: 'pushover_personal', userId: 'u-1' } }]);
  });
});
