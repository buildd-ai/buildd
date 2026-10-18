import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createChangeVersions, setChangeVersionsForTests, bumpChangeVersions, listTag, ifNoneMatchHolds, notModifiedFor, withTag,
  queryKey, wsScope, teamScope, type ChangeVersionDeps,
} from './change-version';

let kv: Map<string, string>;
let available: boolean;
let resolved: Array<{ workspaceId: string | null; teamId: string | null }>;
let resolveCalls: unknown[];
let n: number;

const deps = (): ChangeVersionDeps => ({
  getKeys: async (keys) => (available ? keys.map(k => kv.get(k) ?? null) : undefined),
  setKeys: async (entries, _ttl, opts) => {
    if (!available) return false;
    for (const [k, v] of entries) if (!opts?.nx || !kv.has(k)) kv.set(k, v);
    return true;
  },
  resolve: async (t) => { resolveCalls.push(t); return resolved; },
  token: () => `t${++n}`,
});

beforeEach(() => {
  kv = new Map();
  available = true;
  resolved = [];
  resolveCalls = [];
  n = 0;
  setChangeVersionsForTests(createChangeVersions(deps()));
});

const tagFor = (scopes: string[], extra: Partial<Parameters<typeof listTag>[0]> = {}) =>
  listTag({ route: '/api/tasks', caller: 'acct:a', scopes, now: 0, ...extra });

describe('change version', () => {
  it('a scope never written has no tag the first time, then one (seeded, fail open)', async () => {
    expect(await tagFor([wsScope('w1')])).toBeNull();
    const tag = await tagFor([wsScope('w1')]);
    expect(tag).toMatch(/^W\/"cv1-/);
    expect(await tagFor([wsScope('w1')])).toBe(tag);
  });

  it('a write to the workspace changes the tag; a write elsewhere does not', async () => {
    await tagFor([wsScope('w1'), wsScope('w2')]);
    const before = await tagFor([wsScope('w1'), wsScope('w2')]);
    resolved = [{ workspaceId: 'w3', teamId: 'team-b' }];
    await bumpChangeVersions({ taskIds: ['t-other'] });
    expect(await tagFor([wsScope('w1'), wsScope('w2')])).toBe(before);
    resolved = [{ workspaceId: 'w2', teamId: 'team-a' }];
    const bumped = await bumpChangeVersions({ taskIds: ['t1'] });
    expect(bumped).toEqual([teamScope('team-a'), wsScope('w2')]);
    expect(await tagFor([wsScope('w1'), wsScope('w2')])).not.toBe(before);
  });

  it('a workspace write moves its team, so a team-scoped read changes too', async () => {
    await tagFor([teamScope('team-a')]);
    const before = await tagFor([teamScope('team-a')]);
    resolved = [{ workspaceId: 'w2', teamId: 'team-a' }];
    await bumpChangeVersions({ workerIds: ['wk1'] });
    expect(await tagFor([teamScope('team-a')])).not.toBe(before);
  });

  it('named workspaces and teams are bumped; nothing named reads nothing', async () => {
    expect(await bumpChangeVersions({})).toEqual([]);
    expect(resolveCalls).toHaveLength(0);
    expect(await bumpChangeVersions({ teamIds: ['team-z'] })).toEqual([teamScope('team-z')]);
    expect(resolveCalls).toHaveLength(0);
    resolved = [{ workspaceId: 'w9', teamId: 'team-9' }];
    await bumpChangeVersions({ workspacePrs: [{ workspaceId: 'w9', prNumber: 4 }], prs: [{ repoFullName: 'o/r', prNumber: 1 }] });
    expect(resolveCalls[0]).toMatchObject({ workspaceIds: ['w9'], repos: ['o/r'] });
  });

  it('the tag differs by caller, query and time bucket', async () => {
    await tagFor([wsScope('w1')]);
    const base = await tagFor([wsScope('w1')]);
    expect(await tagFor([wsScope('w1')], { caller: 'acct:b' })).not.toBe(base);
    expect(await tagFor([wsScope('w1')], { vary: ['status=active'] })).not.toBe(base);
    expect(await tagFor([wsScope('w1')], { now: 10 * 60_000 })).not.toBe(base);
    expect(await tagFor([wsScope('w1')], { now: 10 * 60_000, bucketMs: 3_600_000 })).toBe(await tagFor([wsScope('w1')], { bucketMs: 3_600_000 }));
  });

  it('Redis unavailable: no tag, and a bump never throws', async () => {
    available = false;
    expect(await tagFor([wsScope('w1')])).toBeNull();
    resolved = [{ workspaceId: 'w1', teamId: null }];
    expect(await bumpChangeVersions({ taskIds: ['t1'] })).toEqual([wsScope('w1')]);
  });

  it('a resolve that throws is swallowed', async () => {
    setChangeVersionsForTests(createChangeVersions({ ...deps(), resolve: async () => { throw new Error('db down'); } }));
    expect(await bumpChangeVersions({ taskIds: ['t1'] })).toEqual([]);
  });

  it('no scopes, no tag', async () => {
    expect(await tagFor([])).toBeNull();
  });
});

describe('If-None-Match', () => {
  const tag = 'W/"cv1-abc"';
  it('matches weakly, in a list, and on *', () => {
    expect(ifNoneMatchHolds(tag, tag)).toBe(true);
    expect(ifNoneMatchHolds('"cv1-abc"', tag)).toBe(true);
    expect(ifNoneMatchHolds('"x", W/"cv1-abc"', tag)).toBe(true);
    expect(ifNoneMatchHolds('*', tag)).toBe(true);
    expect(ifNoneMatchHolds('W/"cv1-other"', tag)).toBe(false);
    expect(ifNoneMatchHolds(null, tag)).toBe(false);
    expect(ifNoneMatchHolds(tag, null)).toBe(false);
  });

  it('notModifiedFor answers 304 with the tag and no body; withTag stamps a 200 only', async () => {
    const req = { headers: new Headers({ 'if-none-match': tag }) };
    const res = notModifiedFor(req, tag)!;
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(tag);
    expect(await res.text()).toBe('');
    expect(notModifiedFor({ headers: new Headers() }, tag)).toBeNull();
    expect(withTag(Response.json({}), tag).headers.get('etag')).toBe(tag);
    expect(withTag(Response.json({}, { status: 500 }), tag).headers.get('etag')).toBeNull();
    expect(withTag(Response.json({}), null).headers.get('etag')).toBeNull();
  });

  it('queryKey is order-independent', () => {
    expect(queryKey(new URLSearchParams('b=2&a=1'))).toBe(queryKey(new URLSearchParams('a=1&b=2')));
  });
});
