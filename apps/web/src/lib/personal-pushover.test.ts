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
  sanitizePushoverUserKey, personalSenderToken, sendPushoverMessage, validatePushoverUser, setPersonalPushover,
} = await import('./personal-pushover');

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

  it('a good key is stored as the caller\'s personal row, purpose pushover_personal', async () => {
    const r = await setPersonalPushover({ userId: 'u-1', teamId: 't-1', value: KEY }, { token: 't', fetch: fakeFetch(200, { status: 1 }) });
    expect(r.ok).toBe(true);
    expect(writes[0]).toEqual(['replaceScoped', { value: KEY, meta: { teamId: 't-1', purpose: 'pushover_personal', userId: 'u-1' } }]);
  });
});
