/**
 * Superseded integration-refresh PR retirement: verify (ancestry + content),
 * retire (close, comment once, record edge), and the sweep's candidate choice.
 * GitHub is a fake keyed by API path; the db is injected via `load`.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_e: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({ GATE_SLUGS: REAL_GATE_SLUGS, fireGateEvent: mockFireGateEvent }));
mock.module('@/lib/github', () => ({ githubApi: async () => ({}) }));
mock.module('@/lib/workspace-installation', () => ({ createTeamInstallationResolver: () => ({ forWorkspace: async () => ({ installationId: 1 }) }) }));
mock.module('@/lib/repo-scope', () => ({ repoFullNameFromPrUrl: () => 'org/repo' }));
const mockRecord = mock(async (_p: any): Promise<any> => ({ ok: true }));
mock.module('@/lib/pr-supersession', () => ({ recordPrSupersession: mockRecord }));

const {
  retireSupersededRefreshPr,
  sweepSupersededRefreshPrs,
  verifyRefreshSuperseded,
  shouldSkipExhaustedRefreshPr,
  REFRESH_SUPERSESSION_MARKER,
  REFRESH_DEFERRAL_EXHAUSTED_KEY,
} = await import('./pr-supersession-refresh');

const BRANCH = 'mission/abc-integration';
const refresh = (trunkSha: string, missionHeadSha: string) => ({ trunk: 'dev', trunkSha, missionHeadSha });
const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  workerId: `w${n}`, taskId: `t${n}`, workspaceId: 'ws', missionId: 'm1', repo: 'org/repo', prNumber: n,
  refresh: refresh(`trunk${n}`, 'missionhead'), ...extra,
});
const OLDER = pr(4275);
const NEWER = pr(4303, { refresh: refresh('trunk4303', 'missionhead') });

const sqlBody = 'sql-blob-1';
const file = (filename: string, sha: string, patch: string, status = 'added') => ({ filename, status, sha, patch, additions: 1, deletions: 0 });
const lines = (...l: string[]) => l.map(x => `+${x}`).join('\n');

interface World {
  olderState: string; olderMerged: boolean; newerMerged: boolean; newerBase: string;
  ancestors: Set<string>;            // shas reachable from the branch head
  olderDelta: any[] | null; branchDelta: any[] | null;
  comments: any[]; failClose: number;
}
let w: World;
let calls: string[];
const fresh = (): World => ({
  olderState: 'open', olderMerged: false, newerMerged: true, newerBase: BRANCH,
  ancestors: new Set(['trunk4275', 'missionhead']),
  olderDelta: [
    file('apps/web/src/lib/feature.ts', 'blobA', lines('export const featureFlag = true;', 'export function runFeature() {}', 'const another = computeSomething(1);')),
    file('packages/core/drizzle/0150_old_name.sql', sqlBody, lines('ALTER TABLE x ADD COLUMN y text;')),
    file('packages/core/drizzle/meta/0150_snapshot.json', 'snapOld', lines('"id": "old-snapshot-id"')),
  ],
  branchDelta: [
    file('apps/web/src/lib/feature.ts', 'blobB', lines('export const featureFlag = true;', 'export function runFeature() {}', 'const another = computeSomething(1);', 'export const more = 2;')),
    file('packages/core/drizzle/0153_new_name.sql', sqlBody, lines('ALTER TABLE x ADD COLUMN y text;')),
    file('packages/core/drizzle/meta/0153_snapshot.json', 'snapNew', lines('"id": "new-snapshot-id"')),
  ],
  comments: [], failClose: 0,
});

const api = async (_i: number, path: string, init?: any) => {
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${path}`);
  if (method === 'PATCH') {
    if (w.failClose > 0) { w.failClose--; throw new Error('boom'); }
    w.olderState = 'closed';
    return {};
  }
  if (method === 'POST') { w.comments.push({ body: JSON.parse(init.body).body }); return {}; }
  if (path.includes('/comments')) return w.comments;
  if (path.endsWith('/pulls/4275')) return { state: w.olderState, merged: w.olderMerged, base: { ref: BRANCH }, head: { sha: 'olderhead' } };
  if (path.endsWith('/pulls/4303')) return { state: 'closed', merged: w.newerMerged, base: { ref: w.newerBase }, head: { sha: 'newerhead' } };
  if (path.includes('/git/ref/heads/')) return { object: { sha: 'branchhead' } };
  const cmp = path.match(/\/compare\/(.+)\.\.\.(.+)$/);
  if (cmp) {
    const [, a, b] = cmp;
    if (a === 'dev') {
      const files = b === 'olderhead' ? w.olderDelta : w.branchDelta;
      if (!files) throw new Error('compare failed');
      return { files };
    }
    if (b === 'branchhead') return { status: w.ancestors.has(a) ? 'ahead' : 'diverged' };
  }
  throw new Error(`unexpected ${method} ${path}`);
};

beforeEach(() => {
  w = fresh(); calls = [];
  mockFireGateEvent.mockClear(); mockRecord.mockClear();
  mockRecord.mockImplementation(async () => ({ ok: true }));
});

const mutations = () => calls.filter(c => !c.startsWith('GET'));
const events = (outcome: string) => mockFireGateEvent.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.outcome === outcome);

describe('verifyRefreshSuperseded', () => {
  it('verifies when ancestry holds and a regenerated migration has the same SQL under a new number', async () => {
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v).toMatchObject({ ok: true, branch: BRANCH, migrationsMatched: 1, closedOnGitHub: false });
  });

  it('refuses when a line the older PR adds is not in the branch (independent work)', async () => {
    w.olderDelta!.push(file('apps/web/src/lib/only-here.ts', 'blobC', lines('export const uniqueWork = 1;', 'export const moreWork = 2;', 'export function doIt() {}')));
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain('not in');
  });

  it('refuses when the older PR adds a migration whose SQL is not in the branch', async () => {
    w.olderDelta![1] = file('packages/core/drizzle/0150_old_name.sql', 'different', lines('ALTER TABLE z ADD COLUMN q text;'));
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain('migration');
  });

  // drizzle v1 folders (`drizzle/<ts>_<slug>/migration.sql` + `snapshot.json`) matched neither
  // migration pattern before, so a regenerated folder migration was never twin-checked by SQL.
  it('matches a regenerated drizzle v1 folder migration by identical SQL, and refuses a different one', async () => {
    const folder = (slug: string, sqlSha: string, snap: string) => [
      file(`packages/core/drizzle/${slug}/migration.sql`, sqlSha, lines('ALTER TABLE x ADD COLUMN y text;')),
      file(`packages/core/drizzle/${slug}/snapshot.json`, snap, lines(`"id": "${snap}"`)),
    ];
    w.olderDelta = [w.olderDelta![0], ...folder('20261020000000_add_y', sqlBody, 'snapOld')];
    w.branchDelta = [w.branchDelta![0], ...folder('20261022000000_add_y', sqlBody, 'snapNew')];
    expect(await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api })).toMatchObject({ ok: true, migrationsMatched: 1 });

    w.branchDelta = [w.branchDelta![0], ...folder('20261022000000_add_y', 'other-sql', 'snapNew')];
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v.ok).toBe(false);
    expect((v as any).reason).toContain('20261020000000_add_y/migration.sql');
  });

  it('refuses when trunk or mission head from the older refresh is not an ancestor of the branch', async () => {
    w.ancestors.delete('trunk4275');
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v.ok).toBe(false);
    expect((v as any).transient).toBe(false);
  });

  it('refuses when the newer PR is not merged or targets another branch', async () => {
    w.newerMerged = false;
    expect((await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api })).ok).toBe(false);
    w = { ...fresh(), newerBase: 'mission/other' };
    expect((await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api })).ok).toBe(false);
  });

  it('fails closed, as transient, when a file list cannot be read', async () => {
    w.branchDelta = null;
    const v = await verifyRefreshSuperseded({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(v).toMatchObject({ ok: false, transient: true });
  });
});

describe('retireSupersededRefreshPr', () => {
  it('closes, comments once with the marker, records the edge, and writes an accepted gate event', async () => {
    const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(out).toMatchObject({ outcome: 'retired', prNumber: 4275, supersededBy: 4303 });
    expect(mutations().map(c => c.split(' ')[0])).toEqual(['PATCH', 'POST']);
    expect(w.comments[0].body).toContain(REFRESH_SUPERSESSION_MARKER);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ workerId: 'w4275', supersedingPrNumber: 4303, recordedBy: 'system:refresh-supersession' });
    expect(mockRecord.mock.calls[0][0].reason).toContain('regenerated migration');
    expect(events('accepted')).toHaveLength(1);
  });

  it('changes nothing and records a deferred event when verification fails', async () => {
    w.ancestors.delete('missionhead');
    const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(out.outcome).toBe('kept');
    expect(mutations()).toEqual([]);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(events('deferred')).toHaveLength(1);
  });

  it('retry after a failed close: no comment, no edge, stranded event; the next run completes', async () => {
    w.failClose = 1;
    const first = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(first.outcome).toBe('kept');
    expect(w.comments).toHaveLength(0);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(events('stranded')).toHaveLength(1);

    const second = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(second.outcome).toBe('retired');
    expect(w.comments).toHaveLength(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('retry after a half-finished run: already closed and commented, only the edge is recorded', async () => {
    w.olderState = 'closed';
    w.comments = [{ body: `${REFRESH_SUPERSESSION_MARKER}\nold` }];
    const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(out.outcome).toBe('retired');
    expect(mutations()).toEqual([]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  // Incident 197552dc review: a record the kernel's host did not take is not a stranded PR.
  it('an outage on the record is deferred: no stranded event, and the PR stays retryable', async () => {
    mockRecord.mockImplementation(async () => ({ ok: false, status: 503, error: 'the pass spent its control-plane budget', door: { body: { code: 'control_plane_unavailable', outcome: 'not_applied' }, headers: {} } }));
    const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(out.outcome).toBe('deferred');
    expect(events('stranded')).toHaveLength(0);
  });

  for (const [what, code, status] of [['a refusal', 'control_plane_refused', 403], ['the command failing there', 'command_failed', 500]] as const) {
    it(`${what} (${status} ${code}) is deterministic: kept with a stranded event, as before, never deferred`, async () => {
      mockRecord.mockImplementation(async () => ({ ok: false, status, error: `door said ${code}`, door: { body: { code }, headers: {} } }));
      const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
      expect(out.outcome).toBe('kept');
      expect(events('stranded')).toHaveLength(1);
    });
  }

  it('treats an already-recorded edge (409) as done, not as a failure', async () => {
    mockRecord.mockImplementation(async () => ({ ok: false, status: 409, error: 'already recorded' }));
    const out = await retireSupersededRefreshPr({ installationId: 1, older: OLDER, newer: NEWER, api });
    expect(out.outcome).toBe('retired');
    expect(events('stranded')).toHaveLength(0);
  });
});

describe('sweepSupersededRefreshPrs', () => {
  const run = (open: any[], merged: any[]) =>
    sweepSupersededRefreshPrs(new Date(), { load: async () => ({ open, merged }), installation: async () => 1, api });

  it('retires the older open refresh when a higher-numbered one merged in the same mission', async () => {
    const r = await run([OLDER], [NEWER]);
    expect(r).toEqual({ candidates: 1, retired: 1, kept: 0, skipped: 0, deferred: 0, deferralExhausted: 0 });
  });

  it('leaves unrelated PRs alone: other mission, lower-numbered merged refresh, or no successor', async () => {
    const otherMission = pr(4400, { missionId: 'm2' });
    const olderMerged = pr(4100);
    const r = await run([OLDER, otherMission], [olderMerged, pr(4500, { missionId: 'm3' })]);
    expect(r.candidates).toBe(0);
    expect(mutations()).toEqual([]);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('counts a candidate whose verification fails as kept, not retired', async () => {
    w.olderDelta!.push(file('apps/web/src/lib/only-here.ts', 'blobC', lines('export const uniqueWork = 1;', 'export const moreWork = 2;', 'export function doIt() {}')));
    const r = await run([OLDER], [NEWER]);
    expect(r).toEqual({ candidates: 1, retired: 0, kept: 1, skipped: 0, deferred: 0, deferralExhausted: 0 });
    expect(mutations()).toEqual([]);
  });

  it('is idempotent across runs: a second run after retirement finds nothing left to do', async () => {
    await run([OLDER], [NEWER]);
    mockRecord.mockClear();
    const again = await run([], [NEWER]); // the edge now excludes it from the open set
    expect(again.candidates).toBe(0);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a deferred record stops at the first successor: the next one would only wait on the control plane again', async () => {
    mockRecord.mockImplementation(async () => ({ ok: false, status: 503, error: 'control plane did not answer', door: { body: { code: 'control_plane_unavailable' }, headers: {} } }));
    const r = await run([OLDER], [NEWER, pr(4310, { refresh: refresh('trunk4310', 'missionhead') })]);
    expect(r).toMatchObject({ candidates: 1, retired: 0, kept: 0, deferred: 1 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('a deferral is kept on the task each tick, and past the cap it stops with a stranded event a person sees', async () => {
    mockRecord.mockImplementation(async () => ({ ok: false, status: 503, error: 'control plane did not answer', door: { body: { code: 'control_plane_unavailable' }, headers: {} } }));
    const saved: Array<{ taskId: string; count: number; exhausted: boolean }> = [];
    const saveDeferral = async (taskId: string, state: { count: number }, exhausted: boolean) => { saved.push({ taskId, count: state.count, exhausted }); };
    const now = new Date('2026-10-14T23:10:00Z');
    const first = await sweepSupersededRefreshPrs(now, { load: async () => ({ open: [OLDER], merged: [NEWER] }), installation: async () => 1, api, saveDeferral });
    expect(first).toMatchObject({ deferred: 1, deferralExhausted: 0 });
    expect(saved).toEqual([{ taskId: 't4275', count: 1, exhausted: false }]);
    expect(events('stranded')).toHaveLength(0);

    const late = { ...OLDER, deferral: { firstAt: '2026-10-14T00:10:00Z', count: 23, reason: 'cp down' } };
    const last = await sweepSupersededRefreshPrs(now, { load: async () => ({ open: [late], merged: [NEWER] }), installation: async () => 1, api, saveDeferral });
    expect(last).toMatchObject({ deferred: 1, deferralExhausted: 1 });
    expect(saved.at(-1)).toEqual({ taskId: 't4275', count: 24, exhausted: true });
    expect(events('stranded')).toHaveLength(1);
    expect(mockFireGateEvent.mock.calls.at(-1)![0]).toMatchObject({ outcome: 'stranded', detail: expect.objectContaining({ kind: 'control_plane_deferral_exhausted' }) });
  });

  it('skips a repo with no installation', async () => {
    const r = await sweepSupersededRefreshPrs(new Date(), { load: async () => ({ open: [OLDER], merged: [NEWER] }), installation: async () => null, api });
    expect(r).toEqual({ candidates: 1, retired: 0, kept: 0, skipped: 1, deferred: 0, deferralExhausted: 0 });
  });

  it('when a deferral is exhausted, the sweep sets the exhausted flag and fires a stranded event', async () => {
    mockRecord.mockImplementation(async () => ({ ok: false, status: 503, error: 'control plane did not answer', door: { body: { code: 'control_plane_unavailable' }, headers: {} } }));
    const exhaustedPr = { ...OLDER, deferral: { firstAt: '2026-10-14T00:10:00Z', count: 24, reason: 'cp down' } };
    const now = new Date('2026-10-14T23:10:00Z');
    const saved: Array<{ taskId: string; count: number; exhausted: boolean }> = [];
    const saveDeferral = async (taskId: string, state: { count: number }, exhausted: boolean) => { saved.push({ taskId, count: state.count, exhausted }); };
    const r = await sweepSupersededRefreshPrs(now, {
      load: async () => ({ open: [exhaustedPr], merged: [NEWER] }),
      installation: async () => 1,
      api,
      saveDeferral,
    });
    expect(r).toEqual({ candidates: 1, retired: 0, kept: 0, skipped: 0, deferred: 1, deferralExhausted: 1 });
    expect(saved.at(-1)).toEqual({ taskId: 't4275', count: 25, exhausted: true });
    expect(mockFireGateEvent.mock.calls.some((c: any[]) => c[0].outcome === 'stranded' && c[0].detail.kind === 'control_plane_deferral_exhausted')).toBe(true);
  });

  it('an exhausted PR is excluded from the sweep by shouldSkipExhaustedRefreshPr', () => {
    // The filter excludes PRs whose context carries the exhausted flag.
    expect(shouldSkipExhaustedRefreshPr({})).toBe(false);
    expect(shouldSkipExhaustedRefreshPr({ other: 'value' })).toBe(false);
    expect(shouldSkipExhaustedRefreshPr({ [REFRESH_DEFERRAL_EXHAUSTED_KEY]: true })).toBe(true);
    expect(shouldSkipExhaustedRefreshPr({ [REFRESH_DEFERRAL_EXHAUSTED_KEY]: false })).toBe(false);
  });

  it('a successful retire clears the deferral so future outages start fresh', async () => {
    const cleared: string[] = [];
    const clearDeferral = async (taskId: string) => { cleared.push(taskId); };
    const r = await sweepSupersededRefreshPrs(new Date(), {
      load: async () => {
        const prWithOldDeferral = { ...OLDER, deferral: { firstAt: '2026-10-13T00:00:00Z', count: 5, reason: 'prior outage' } };
        return { open: [prWithOldDeferral], merged: [NEWER] };
      },
      installation: async () => 1,
      api,
      clearDeferral,
    });
    expect(r.retired).toBe(1);
    expect(cleared).toEqual(['t4275']);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('a 409 response (edge already exists) also clears the deferral', async () => {
    const cleared: string[] = [];
    const clearDeferral = async (taskId: string) => { cleared.push(taskId); };
    mockRecord.mockImplementation(async () => ({ ok: false, status: 409, error: 'edge exists' }));
    const r = await sweepSupersededRefreshPrs(new Date(), {
      load: async () => {
        const prWithOldDeferral = { ...OLDER, deferral: { firstAt: '2026-10-13T00:00:00Z', count: 5, reason: 'prior outage' } };
        return { open: [prWithOldDeferral], merged: [NEWER] };
      },
      installation: async () => 1,
      api,
      clearDeferral,
    });
    expect(r.retired).toBe(1);
    expect(cleared).toEqual(['t4275']);
  });

  it('a failed record does not clear the deferral', async () => {
    const cleared: string[] = [];
    const clearDeferral = async (taskId: string) => { cleared.push(taskId); };
    mockRecord.mockImplementation(async () => ({ ok: false, status: 500, error: 'server error' }));
    const r = await sweepSupersededRefreshPrs(new Date(), {
      load: async () => ({ open: [OLDER], merged: [NEWER] }),
      installation: async () => 1,
      api,
      clearDeferral,
    });
    expect(r.kept).toBe(1);
    expect(cleared).toHaveLength(0);
  });
});
