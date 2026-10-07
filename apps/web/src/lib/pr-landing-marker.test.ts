import { beforeEach, describe, expect, it, mock } from 'bun:test';

let updateReturns: any[] = [];
let captured: any[] = [];
let findFirstResult: any = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: { tasks: { findFirst: () => findFirstResult } },
    update: () => ({
      set: (vals: any) => ({
        where: (cond: any) => {
          captured.push({ vals, cond });
          return { returning: () => updateReturns.shift() ?? [] };
        },
      }),
    }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'tasks.id', context: 'tasks.context', updatedAt: 'tasks.updatedAt' } }));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  sql: (strings: any, ...values: any[]) => ({ type: 'sql', strings, values }),
}));

import { parseLandingMarker, readLandingMarker, writeLandingMarker, clearLandingMarker, claimReviewRevalidation } from './pr-landing-marker';

const stored = {
  prNumber: 42,
  pendingHeadSha: 'head2',
  baseShaAtUpdate: 'base1',
  refreshCount: 2,
  firstApprovedGreenAt: '2030-01-01T00:00:00.000Z',
  lastOutcome: 'updating_branch',
  pagedKeys: ['a', 7],
};

beforeEach(() => {
  updateReturns = [];
  captured = [];
  findFirstResult = null;
});

describe('parseLandingMarker', () => {
  it('reads a well-formed marker for the PR and keeps only string paged keys', () => {
    expect(parseLandingMarker({ landing: stored }, 42)).toEqual({ ...stored, pagedKeys: ['a'] });
  });

  it.each([
    ['no context', null],
    ['no landing key', { other: 1 }],
    ['landing for another PR', { landing: { ...stored, prNumber: 7 } }],
    ['no pending head', { landing: { ...stored, pendingHeadSha: '' } }],
    ['landing is not an object', { landing: 'x' }],
  ])('returns null for %s', (_n, ctx) => {
    expect(parseLandingMarker(ctx, 42)).toBeNull();
  });

  it('carries updatedAt when stored as a string and omits it otherwise', () => {
    const at = '2030-01-01T00:30:00.000Z';
    expect(parseLandingMarker({ landing: { ...stored, updatedAt: at } }, 42)?.updatedAt).toBe(at);
    expect(parseLandingMarker({ landing: stored }, 42)).not.toHaveProperty('updatedAt');
    expect(parseLandingMarker({ landing: { ...stored, updatedAt: 5 } }, 42)).not.toHaveProperty('updatedAt');
  });

  it('defaults malformed optional fields instead of throwing', () => {
    const m = parseLandingMarker({ landing: { prNumber: 42, pendingHeadSha: 'h', refreshCount: -1, baseShaAtUpdate: 5 } }, 42);
    expect(m).toMatchObject({ refreshCount: 0, baseShaAtUpdate: null, firstApprovedGreenAt: null, lastOutcome: 'updating_branch' });
  });
});

describe('marker storage', () => {
  it('reads the marker off the owning task', async () => {
    findFirstResult = { context: { landing: stored } };
    expect((await readLandingMarker('t1', 42))?.pendingHeadSha).toBe('head2');
    findFirstResult = undefined;
    expect(await readLandingMarker('t1', 42)).toBeNull();
  });

  it('write is one conditional update: true when the counter matched, false when another landing won', async () => {
    const { pagedKeys: _p, ...marker } = stored;
    updateReturns = [[{ id: 't1' }], []];
    expect(await writeLandingMarker('t1', marker, 1)).toBe(true);
    expect(await writeLandingMarker('t1', marker, 1)).toBe(false);
    const cond = captured[0].cond;
    expect(cond.type).toBe('and');
    expect(JSON.stringify(cond.args[1].values)).toContain('1');
  });

  it('write never names pagedKeys, so the stored alert-dedupe list survives', async () => {
    const { pagedKeys: _p, ...marker } = stored;
    updateReturns = [[{ id: 't1' }]];
    await writeLandingMarker('t1', marker, 0);
    const json = captured[0].vals.context.values.find((v: unknown) => typeof v === 'string' && v.startsWith('{'));
    expect(JSON.parse(json)).not.toHaveProperty('pagedKeys');
  });

  it('write stamps updatedAt so the sweeper can age the refresh wait', async () => {
    const { pagedKeys: _p, ...marker } = stored;
    updateReturns = [[{ id: 't1' }]];
    const before = Date.now();
    await writeLandingMarker('t1', marker, 0);
    const json = captured[0].vals.context.values.find((v: unknown) => typeof v === 'string' && v.startsWith('{'));
    const at = Date.parse(JSON.parse(json).updatedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('clear issues an update', async () => {
    await clearLandingMarker('t1');
    expect(captured).toHaveLength(1);
  });
});

describe('claimReviewRevalidation', () => {
  it('claims once per review task: true when the UPDATE matched, false when it was already claimed', async () => {
    updateReturns = [[{ id: 'task-1' }], []];
    expect(await claimReviewRevalidation('task-1', 'review-3')).toBe(true);
    expect(await claimReviewRevalidation('task-1', 'review-3')).toBe(false);
    // The guard is in the WHERE, so two concurrent landings cannot both claim it.
    const where = JSON.stringify(captured[0].cond);
    expect(where).toContain('revalidatedReviews');
    expect(where).toContain('review-3');
  });
});
