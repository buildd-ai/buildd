import { describe, it, expect } from 'bun:test';
import {
  resolveSemanticRefreshMode,
  parseHunkRanges,
  assessSemanticOverlap,
  UNAVAILABLE_SYMBOL_PROVIDER,
  getServerSymbolProvider,
  type RevisionSymbolProvider,
  type SymbolLookupRequest,
} from './semantic-refresh';

const HEAD = 'h'.repeat(40);
const TIP = 't'.repeat(40);
const MB = 'm'.repeat(40);
const BASE = { installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: HEAD };

type FileRow = { filename: string; patch?: string; previous_filename?: string; status?: string };

/** A fake GitHub keyed by path. PR side = compare TIP...HEAD; base side = compare HEAD...TIP. */
function fakeApi(opts: {
  liveHead?: string;
  baseRef?: string;
  prFiles: FileRow[];
  baseFiles: FileRow[];
  fail?: string;
}) {
  const calls: string[] = [];
  const api = async (_id: number, path: string) => {
    calls.push(path);
    if (opts.fail && path.includes(opts.fail)) throw new Error('GitHub API error: 502 Bad Gateway');
    if (path === '/repos/acme/app/pulls/7') {
      return { state: 'open', head: { sha: opts.liveHead ?? HEAD }, base: { ref: opts.baseRef ?? 'dev' } };
    }
    if (path.startsWith('/repos/acme/app/commits/')) return { sha: TIP };
    if (path === `/repos/acme/app/compare/${TIP}...${HEAD}`) return { merge_base_commit: { sha: MB }, files: opts.prFiles };
    if (path === `/repos/acme/app/compare/${HEAD}...${TIP}`) return { merge_base_commit: { sha: MB }, files: opts.baseFiles };
    throw new Error(`unexpected path ${path}`);
  };
  return { api, calls };
}

/** A provider that answers at exactly the requested revision from a static table. */
function pinnedProvider(table: (req: SymbolLookupRequest) => string[]): RevisionSymbolProvider & { calls: SymbolLookupRequest[] } {
  const calls: SymbolLookupRequest[] = [];
  return {
    calls,
    async lookup(req) {
      calls.push(req);
      return { status: 'ok', revision: req.revision, symbols: table(req) };
    },
  };
}

const P = (start: number, len: number) => `@@ -${start},${len} +${start},${len} @@ ctx\n-a\n+b`;

describe('resolveSemanticRefreshMode', () => {
  it('is off unless explicitly shadow or enforce', () => {
    expect(resolveSemanticRefreshMode(null)).toBe('off');
    expect(resolveSemanticRefreshMode({} as any)).toBe('off');
    expect(resolveSemanticRefreshMode({ semanticRefresh: 'yes' } as any)).toBe('off');
    expect(resolveSemanticRefreshMode({ semanticRefresh: 'shadow' } as any)).toBe('shadow');
    expect(resolveSemanticRefreshMode({ semanticRefresh: 'enforce' } as any)).toBe('enforce');
  });
});

describe('parseHunkRanges', () => {
  it('reads old and new line ranges from hunk headers', () => {
    expect(parseHunkRanges('@@ -10,3 +12,4 @@ fn\n a\n-b\n+c')).toEqual({
      old: [{ start: 10, end: 12 }],
      new: [{ start: 12, end: 15 }],
    });
  });

  it('treats an omitted count as one line and a zero count as no range', () => {
    expect(parseHunkRanges('@@ -0,0 +1 @@\n+x')).toEqual({ old: [], new: [{ start: 1, end: 1 }] });
  });

  it('fails closed on a malformed header (including a stray CR)', () => {
    expect(parseHunkRanges('@@ nonsense @@\n+x')).toBeNull();
    expect(parseHunkRanges('@@ -1,2 +1,2 @@ a\rb\n+x')).not.toBeNull();
    expect(parseHunkRanges('@@ -1,\r2 +1,2 @@\n+x')).toBeNull();
    expect(parseHunkRanges('')).toBeNull();
  });
});

describe('the deployed server has no revision-pinned symbol index', () => {
  it('the server provider is the unavailable one', async () => {
    expect(getServerSymbolProvider()).toBe(UNAVAILABLE_SYMBOL_PROVIDER);
    const r = await UNAVAILABLE_SYMBOL_PROVIDER.lookup({ repoFullName: 'acme/app', revision: HEAD, path: 'a.ts', ranges: [] });
    expect(r.status).toBe('unavailable');
  });
});

describe('assessSemanticOverlap', () => {
  it('a moved head is head_changed, with no symbol lookup', async () => {
    const { api } = fakeApi({ liveHead: 'x'.repeat(40), prFiles: [], baseFiles: [] });
    const provider = pinnedProvider(() => ['s']);
    const r = await assessSemanticOverlap({ ...BASE, api, provider });
    expect(r.verdict).toBe('head_changed');
    expect(provider.calls).toHaveLength(0);
  });

  it('clearly disjoint paths need no symbol lookup', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 1) }], baseFiles: [{ filename: 'b.ts', patch: P(1, 1) }] });
    const provider = pinnedProvider(() => ['s']);
    const r = await assessSemanticOverlap({ ...BASE, api, provider });
    expect(r.verdict).toBe('disjoint_paths');
    expect(provider.calls).toHaveLength(0);
    expect(r.baseSha).toBe(TIP);
    expect(r.mergeBaseSha).toBe(MB);
  });

  it('reads the PR\'s actual base (a mission integration branch), not trunk', async () => {
    const { api, calls } = fakeApi({ baseRef: 'mission/x-1234', prFiles: [], baseFiles: [] });
    await assessSemanticOverlap({ ...BASE, api, provider: pinnedProvider(() => []) });
    expect(calls).toContain(`/repos/acme/app/commits/${encodeURIComponent('mission/x-1234')}`);
  });

  it('a shared file with no reachable index is unknown — never asserted disjoint', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(40, 2) }] });
    const r = await assessSemanticOverlap({ ...BASE, api });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toMatch(/symbol index/);
    expect(r.sharedPaths).toEqual(['a.ts']);
  });

  it('a verified same-symbol edit on both sides is same_symbol, with evidence', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(5, 2) }] });
    const provider = pinnedProvider(() => ['a.ts::computeTotal']);
    const r = await assessSemanticOverlap({ ...BASE, api, provider });
    expect(r.verdict).toBe('same_symbol');
    expect(r.evidence).toEqual([{ path: 'a.ts', symbols: ['a.ts::computeTotal'] }]);
  });

  it('queries each side at its own pinned revision', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(5, 2) }] });
    const provider = pinnedProvider(() => ['x']);
    await assessSemanticOverlap({ ...BASE, api, provider });
    const revs = new Set(provider.calls.map((c) => c.revision));
    expect(revs).toEqual(new Set([MB, HEAD, TIP]));
  });

  it('distinct symbols in a shared file are disjoint_symbols', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(90, 2) }] });
    const provider = pinnedProvider((req) => (req.ranges[0].start < 50 ? ['a.ts::top'] : ['a.ts::bottom']));
    const r = await assessSemanticOverlap({ ...BASE, api, provider });
    expect(r.verdict).toBe('disjoint_symbols');
  });

  it('an index answering at another revision is stale → unknown', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(90, 2) }] });
    const provider: RevisionSymbolProvider = { lookup: async () => ({ status: 'ok', revision: 'other', symbols: ['s'] }) };
    const r = await assessSemanticOverlap({ ...BASE, api, provider });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toMatch(/revision/);
  });

  it('a changed range that maps to no symbol is unknown, not disjoint', async () => {
    const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 2) }], baseFiles: [{ filename: 'a.ts', patch: P(90, 2) }] });
    const r = await assessSemanticOverlap({ ...BASE, api, provider: pinnedProvider(() => []) });
    expect(r.verdict).toBe('unknown');
  });

  it('a truncated file list or a missing patch is unknown', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, patch: P(1, 1) }));
    const t = fakeApi({ prFiles: many, baseFiles: [{ filename: 'zzz.ts', patch: P(1, 1) }] });
    expect((await assessSemanticOverlap({ ...BASE, api: t.api, provider: pinnedProvider(() => ['s']) })).verdict).toBe('unknown');

    const m = fakeApi({ prFiles: [{ filename: 'a.ts' }], baseFiles: [{ filename: 'a.ts', patch: P(1, 1) }] });
    expect((await assessSemanticOverlap({ ...BASE, api: m.api, provider: pinnedProvider(() => ['s']) })).verdict).toBe('unknown');
  });

  it('a lookup budget overrun is unknown', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.ts`, patch: P(1, 1) }));
    const { api } = fakeApi({ prFiles: files, baseFiles: files });
    const provider = pinnedProvider((req) => [`${req.path}::${req.revision.slice(0, 1)}`]);
    const r = await assessSemanticOverlap({ ...BASE, api, provider, limits: { maxLookups: 3 } });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toMatch(/budget/);
  });

  it('a provider that throws or hangs is unknown', async () => {
    const files = [{ filename: 'a.ts', patch: P(1, 1) }];
    const throwing: RevisionSymbolProvider = { lookup: async () => { throw new Error('boom'); } };
    expect((await assessSemanticOverlap({ ...BASE, ...fakeApi({ prFiles: files, baseFiles: files }), provider: throwing })).verdict).toBe('unknown');
    const hanging: RevisionSymbolProvider = { lookup: () => new Promise(() => {}) };
    const r = await assessSemanticOverlap({ ...BASE, ...fakeApi({ prFiles: files, baseFiles: files }), provider: hanging, limits: { lookupTimeoutMs: 10 } });
    expect(r.verdict).toBe('unknown');
  });

  it('a GitHub read failure is unknown, not a conflict', async () => {
    const { api } = fakeApi({ prFiles: [], baseFiles: [], fail: '/compare/' });
    const r = await assessSemanticOverlap({ ...BASE, api, provider: pinnedProvider(() => ['s']) });
    expect(r.verdict).toBe('unknown');
  });

  it('makes no network call of its own beyond the injected GitHub reader', async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; throw new Error('no network'); }) as any;
    try {
      const { api } = fakeApi({ prFiles: [{ filename: 'a.ts', patch: P(1, 1) }], baseFiles: [{ filename: 'b.ts', patch: P(1, 1) }] });
      await assessSemanticOverlap({ ...BASE, api });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
  });
});
