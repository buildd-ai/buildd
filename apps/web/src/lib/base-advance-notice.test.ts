import { describe, expect, test } from 'bun:test';
import { looksLikeMissionIntegrationBranch, resolveTaskPrBase } from '@buildd/core/mission-integration';
import {
  BASE_ADVANCE_DEBOUNCE_MS,
  authorsFromPushCommits,
  baseAdvanceMarker,
  buildBaseAdvanceInstruction,
  changedFilesFromPush,
  isPossibleBaseRef,
  notifyBaseAdvance,
  overlapWithChange,
  resolveCandidateBase,
  type BaseAdvanceCandidate,
  type BaseAdvanceDeps,
  type BaseAdvanceNoticeRecord,
  type BaseResolver,
} from './base-advance-notice';

// The webhook injects exactly these (mission logic is a module; this file is core).
const resolver: BaseResolver = {
  taskPrBase: args => resolveTaskPrBase(args).base,
  looksLikeIntegrationBranch: looksLikeMissionIntegrationBranch,
};

function candidate(over: Partial<BaseAdvanceCandidate> = {}): BaseAdvanceCandidate {
  return {
    workerId: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    missionId: null,
    branch: 'buildd/aaaa1111-feature',
    prNumber: null,
    prBaseRef: null,
    observedTouches: ['apps/web/src/lib/foo.ts'],
    pathManifest: null,
    task: { title: 'Feature', taskClass: null, context: null },
    mission: null,
    gitConfig: { defaultBranch: 'dev' },
    ...over,
  };
}

interface Harness {
  deps: BaseAdvanceDeps;
  queued: Array<{ workerId: string; text: string; marker: string }>;
  recorded: BaseAdvanceNoticeRecord[];
  coalesced: Array<{ id: string; prNumber: number | null }>;
}

function harness(candidates: BaseAdvanceCandidate[], opts: { recent?: Record<string, string> } = {}): Harness {
  const h: Harness = { deps: null as never, queued: [], recorded: [], coalesced: [] };
  const recent = new Map(Object.entries(opts.recent ?? {}));
  h.deps = {
    resolver,
    loadCandidates: async () => candidates,
    findRecentNotice: async (workerId, baseRef) => recent.get(`${workerId}:${baseRef}`) ?? null,
    coalesceNotice: async (id, change) => { h.coalesced.push({ id, prNumber: change.prNumber ?? null }); },
    queueInstruction: async (workerId, text, marker) => {
      h.queued.push({ workerId, text, marker });
      return true;
    },
    recordNotice: async (rec) => {
      h.recorded.push(rec);
      recent.set(`${rec.workerId}:${rec.baseRef}`, `notice-${h.recorded.length}`);
    },
    now: () => new Date('2026-10-07T12:00:00Z'),
  };
  return h;
}

const merged = {
  repoFullName: 'acme/app',
  baseRef: 'dev',
  defaultBranch: 'dev',
  source: 'pull_request' as const,
  change: { prNumber: 42, title: 'feat: rework foo', sha: 'abc1234def', authorBranch: 'buildd/bbbb2222-other' },
};

describe('overlapWithChange', () => {
  test('exact file in observed touches overlaps', () => {
    expect(overlapWithChange(['apps/web/src/lib/foo.ts', 'README.md'], ['apps/web/src/lib/foo.ts'], null))
      .toEqual(['apps/web/src/lib/foo.ts']);
  });

  test('a declared directory in the manifest overlaps files under it (prefix-aware)', () => {
    expect(overlapWithChange(['apps/web/src/lib/foo.ts'], [], ['apps/web/src/lib']))
      .toEqual(['apps/web/src/lib/foo.ts']);
    expect(overlapWithChange(['apps/web/src/lib/foo.ts'], [], ['apps/web/src/lib/**']))
      .toEqual(['apps/web/src/lib/foo.ts']);
  });

  test('a sibling-named directory does not overlap (no substring matching)', () => {
    expect(overlapWithChange(['apps/web/src/library/foo.ts'], ['apps/web/src/lib'], null)).toEqual([]);
  });

  test('the advisory ** sentinel never matches', () => {
    expect(overlapWithChange(['apps/web/src/lib/foo.ts'], [], ['**'])).toEqual([]);
    expect(overlapWithChange(['apps/web/src/lib/foo.ts'], ['**'], ['**'])).toEqual([]);
  });

  test('disjoint files do not overlap', () => {
    expect(overlapWithChange(['docs/a.md'], ['apps/web/src/lib/foo.ts'], ['packages/core'])).toEqual([]);
  });
});

describe('push payload helpers', () => {
  test('changedFilesFromPush unions added/modified/removed, deduplicated', () => {
    expect(changedFilesFromPush([
      { added: ['a.ts'], modified: ['b.ts'], removed: [] },
      { added: [], modified: ['b.ts', 'c.ts'], removed: ['d.ts'] },
    ])).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });

  test('authorsFromPushCommits reads squash and merge-commit messages', () => {
    expect(authorsFromPushCommits([
      { message: 'feat: thing (#123)\n\nbody' },
      { message: 'Merge pull request #77 from acme/buildd/cccc3333-x\n\nTitle' },
      { message: 'chore: direct push' },
    ])).toEqual({ prNumbers: [123, 77], branches: ['buildd/cccc3333-x'] });
  });
});

describe('isPossibleBaseRef', () => {
  test('trunk and mission branches are checked; worker heads are not', () => {
    expect(isPossibleBaseRef('dev')).toBe(true);
    expect(isPossibleBaseRef('mission/foo-12345678')).toBe(true);
    expect(isPossibleBaseRef('buildd/aaaa1111-feature')).toBe(false);
    expect(isPossibleBaseRef(null)).toBe(false);
  });
});

describe('resolveCandidateBase', () => {
  test('a PR base GitHub reported wins', () => {
    expect(resolveCandidateBase(candidate({ prBaseRef: 'main' }), 'dev', resolver)).toBe('main');
  });

  test('a mission integration branch is the base for its tasks', () => {
    expect(resolveCandidateBase(candidate({
      mission: { workingBranch: 'mission/foo-12345678', integrationBranchEnabled: true },
    }), 'dev', resolver)).toBe('mission/foo-12345678');
  });

  test('falls back to the workspace target, then the repo default', () => {
    expect(resolveCandidateBase(candidate({ gitConfig: { defaultBranch: 'dev', targetBranch: 'staging' } }), 'main', resolver)).toBe('staging');
    expect(resolveCandidateBase(candidate({ gitConfig: null }), 'main', resolver)).toBe('main');
  });
});

describe('buildBaseAdvanceInstruction', () => {
  test('names the PR, the files and the rebase command', () => {
    const text = buildBaseAdvanceInstruction({
      baseRef: 'dev', change: merged.change, files: ['apps/web/src/lib/foo.ts'], strategy: 'rebase',
    });
    expect(text).toContain(baseAdvanceMarker('dev'));
    expect(text).toContain('#42');
    expect(text).toContain('feat: rework foo');
    expect(text).toContain('apps/web/src/lib/foo.ts');
    expect(text).toContain('git fetch origin && git rebase origin/dev');
  });

  test('mission integration branches get a merge, not a rebase', () => {
    const text = buildBaseAdvanceInstruction({
      baseRef: 'mission/foo-12345678', change: { sha: 'abc1234' }, files: ['a.ts'], strategy: 'merge',
    });
    expect(text).toContain('git fetch origin && git merge origin/mission/foo-12345678');
    expect(text).not.toContain('git rebase');
  });

  test('a long file list is capped with a count of the rest', () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const text = buildBaseAdvanceInstruction({ baseRef: 'dev', change: {}, files, strategy: 'rebase' });
    expect(text).toContain('f0.ts');
    expect(text).not.toContain('f29.ts');
    expect(text).toContain('and 10 more');
  });
});

describe('notifyBaseAdvance', () => {
  test('an overlapping merge notifies the live worker on that base, and records it', async () => {
    const h = harness([candidate()]);
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts', 'README.md'] }, h.deps);
    expect(out.notified).toEqual(['w-1']);
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0].text).toContain('apps/web/src/lib/foo.ts');
    expect(h.queued[0].text).not.toContain('README.md');
    expect(h.queued[0].marker).toBe(baseAdvanceMarker('dev'));
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      workerId: 'w-1', taskId: 't-1', workspaceId: 'ws-1', baseRef: 'dev',
      overlappingFiles: ['apps/web/src/lib/foo.ts'], source: 'pull_request',
    });
    expect(h.recorded[0].change.prNumber).toBe(42);
  });

  test('disjoint files do not notify', async () => {
    const h = harness([candidate()]);
    const out = await notifyBaseAdvance({ ...merged, files: ['docs/other.md'] }, h.deps);
    expect(out.notified).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  test('a ** manifest with no observed touches never matches', async () => {
    const h = harness([candidate({ observedTouches: null, pathManifest: ['**'] })]);
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(out.notified).toEqual([]);
  });

  test('the declared manifest counts even before any touch is observed', async () => {
    const h = harness([candidate({ observedTouches: null, pathManifest: ['apps/web/src/lib'] })]);
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(out.notified).toEqual(['w-1']);
  });

  test('the worker that authored the change is not notified (by branch or by PR number)', async () => {
    const byBranch = harness([candidate({ branch: 'buildd/bbbb2222-other' })]);
    expect((await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, byBranch.deps)).notified).toEqual([]);

    const byPr = harness([candidate({ prNumber: 42 })]);
    expect((await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, byPr.deps)).notified).toEqual([]);

    const byPushAuthor = harness([candidate({ prNumber: 123 })]);
    expect((await notifyBaseAdvance({
      ...merged, source: 'push', change: { sha: 'f00', authorPrNumbers: [123] }, files: ['apps/web/src/lib/foo.ts'],
    }, byPushAuthor.deps)).notified).toEqual([]);
  });

  test('a worker on a different base is not notified', async () => {
    const h = harness([candidate({ prBaseRef: 'main' })]);
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(out.notified).toEqual([]);
  });

  test('a burst of merges produces one message per worker+base (debounce)', async () => {
    const h = harness([candidate()]);
    await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    const second = await notifyBaseAdvance({
      ...merged, change: { prNumber: 43, title: 'fix: more foo', sha: 'bead' }, files: ['apps/web/src/lib/foo.ts'],
    }, h.deps);
    expect(second.notified).toEqual([]);
    expect(second.debounced).toEqual(['w-1']);
    expect(h.queued).toHaveLength(1);
    expect(h.coalesced).toEqual([{ id: 'notice-1', prNumber: 43 }]);
  });

  test('the debounce lookup is asked about the configured window', async () => {
    const h = harness([candidate()]);
    let since: Date | null = null;
    h.deps.findRecentNotice = async (_w, _b, s) => { since = s; return null; };
    await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(since!.getTime()).toBe(new Date('2026-10-07T12:00:00Z').getTime() - BASE_ADVANCE_DEBOUNCE_MS);
  });

  test('a queue refusal (an undelivered notice already queued) is reported as debounced, not recorded', async () => {
    const h = harness([candidate()]);
    h.deps.queueInstruction = async () => false;
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(out.notified).toEqual([]);
    expect(out.debounced).toEqual(['w-1']);
    expect(h.recorded).toEqual([]);
  });

  test('no changed files: no candidate lookup at all', async () => {
    const h = harness([candidate()]);
    let loaded = false;
    h.deps.loadCandidates = async () => { loaded = true; return []; };
    await notifyBaseAdvance({ ...merged, files: [] }, h.deps);
    expect(loaded).toBe(false);
  });

  test('one failing worker does not stop the others', async () => {
    const h = harness([candidate({ workerId: 'w-bad' }), candidate({ workerId: 'w-2', taskId: 't-2' })]);
    const base = h.deps.queueInstruction;
    h.deps.queueInstruction = async (w, t, m) => { if (w === 'w-bad') throw new Error('boom'); return base(w, t, m); };
    const out = await notifyBaseAdvance({ ...merged, files: ['apps/web/src/lib/foo.ts'] }, h.deps);
    expect(out.notified).toEqual(['w-2']);
  });
});
