import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

/**
 * The person presence token: signed, prefixed, revocable through its row, and
 * accepted only by the presence routes. The store is an in-memory stand-in;
 * `@buildd/core/db` is stubbed so any accidental use fails the test.
 */

mock.module('@buildd/core/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => { throw new Error(`db.${String(prop)} used`); } }),
}));

const {
  PRESENCE_TOKEN_PREFIX,
  isPresenceToken,
  mintPresenceToken,
  verifyPresenceTokenSignature,
  issuePresenceToken,
  authenticatePresenceToken,
  revokePresenceToken,
  normalizePresenceTokenLabel,
} = await import('./presence-token');
type Store = import('./presence-token').PresenceTokenStore;

interface Row { id: string; userId: string; label: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }
let rows: Row[];
let seq: number;
const NOW = new Date('2026-10-07T12:00:00Z');

function memoryStore(): Store {
  return {
    async insert(userId, label, now) {
      const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, userId, label, createdAt: now, lastUsedAt: null, revokedAt: null };
      rows.push(row);
      return { id: row.id };
    },
    async revokeActiveForLabel(userId, label, now) {
      for (const r of rows) if (r.userId === userId && r.label === label && !r.revokedAt) r.revokedAt = now;
    },
    async find(id) {
      const r = rows.find(x => x.id === id);
      return r ? { userId: r.userId, revokedAt: r.revokedAt, lastUsedAt: r.lastUsedAt } : null;
    },
    async touch(id, now) {
      const r = rows.find(x => x.id === id);
      if (r) r.lastUsedAt = now;
    },
    async revoke(id, userId, now) {
      const r = rows.find(x => x.id === id && x.userId === userId && !x.revokedAt);
      if (!r) return false;
      r.revokedAt = now;
      return true;
    },
  };
}

const savedSecret = process.env.AUTH_SECRET;
let store: Store;
const teamsOf = async (userId: string) => (userId === 'user-1' ? ['team-1', 'team-2'] : []);
const deps = () => ({ store, now: NOW, teamIds: teamsOf });

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-for-presence-tokens';
  rows = [];
  seq = 0;
  store = memoryStore();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = savedSecret;
});

describe('signature', () => {
  it('round-trips, carries only ids, and is recognisable by prefix', () => {
    const t = mintPresenceToken({ tokenId: 'tok-1', userId: 'user-1' })!;
    expect(t.startsWith(PRESENCE_TOKEN_PREFIX)).toBe(true);
    expect(isPresenceToken(t)).toBe(true);
    expect(verifyPresenceTokenSignature(t)).toEqual({ tokenId: 'tok-1', userId: 'user-1' });
    const payload = JSON.parse(Buffer.from(t.slice(PRESENCE_TOKEN_PREFIX.length).split('.')[0], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['t', 'u']);
  });

  it('refuses a tampered payload, a foreign prefix and a task token', () => {
    const t = mintPresenceToken({ tokenId: 'tok-1', userId: 'user-1' })!;
    const [payload, sig] = t.slice(PRESENCE_TOKEN_PREFIX.length).split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'tok-1', u: 'user-2' })).toString('base64url');
    expect(verifyPresenceTokenSignature(`${PRESENCE_TOKEN_PREFIX}${forged}.${sig}`)).toBeNull();
    expect(verifyPresenceTokenSignature(`bldt_${payload}.${sig}`)).toBeNull();
    expect(verifyPresenceTokenSignature(`bld_${payload}.${sig}`)).toBeNull();
    expect(verifyPresenceTokenSignature('bldp_garbage')).toBeNull();
  });

  it('fails closed with no signing secret', () => {
    const t = mintPresenceToken({ tokenId: 'tok-1', userId: 'user-1' })!;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect(mintPresenceToken({ tokenId: 'tok-1', userId: 'user-1' })).toBeNull();
    expect(verifyPresenceTokenSignature(t)).toBeNull();
  });
});

describe('issue, authenticate, revoke', () => {
  it('a fresh token authenticates as its person, with every team they are in', async () => {
    const t = (await issuePresenceToken('user-1', 'laptop', deps()))!;
    expect(await authenticatePresenceToken(t, deps())).toMatchObject({ userId: 'user-1', teamIds: ['team-1', 'team-2'] });
    expect(rows[0].lastUsedAt).toEqual(NOW);
  });

  it('one per machine: logging in again on the same machine revokes the old one', async () => {
    const first = (await issuePresenceToken('user-1', 'laptop', deps()))!;
    const second = (await issuePresenceToken('user-1', 'laptop', deps()))!;
    const desktop = (await issuePresenceToken('user-1', 'desktop', deps()))!;
    expect(await authenticatePresenceToken(first, deps())).toBeNull();
    expect(await authenticatePresenceToken(second, deps())).not.toBeNull();
    expect(await authenticatePresenceToken(desktop, deps())).not.toBeNull();
  });

  it('a revoked token, a deleted row or a row of another user is refused', async () => {
    const t = (await issuePresenceToken('user-1', 'laptop', deps()))!;
    expect(await revokePresenceToken(t, deps())).toBe(true);
    expect(await authenticatePresenceToken(t, deps())).toBeNull();
    expect(await revokePresenceToken(t, deps())).toBe(false);

    const gone = mintPresenceToken({ tokenId: '00000000-0000-4000-8000-000000000999', userId: 'user-1' })!;
    expect(await authenticatePresenceToken(gone, deps())).toBeNull();

    const real = (await issuePresenceToken('user-1', 'other', deps()))!;
    const { tokenId } = verifyPresenceTokenSignature(real)!;
    const wrongUser = mintPresenceToken({ tokenId, userId: 'user-2' })!;
    expect(await authenticatePresenceToken(wrongUser, deps())).toBeNull();
  });

  it('a person in no team anymore is refused', async () => {
    const t = (await issuePresenceToken('user-3', 'laptop', deps()))!;
    expect(await authenticatePresenceToken(t, deps())).toBeNull();
  });

  it('labels are trimmed, bounded and default to "cli"', () => {
    expect(normalizePresenceTokenLabel('  my-mac.local  ')).toBe('my-mac.local');
    expect(normalizePresenceTokenLabel('')).toBe('cli');
    expect(normalizePresenceTokenLabel(undefined)).toBe('cli');
    expect(normalizePresenceTokenLabel('x'.repeat(200))).toHaveLength(64);
  });
});
