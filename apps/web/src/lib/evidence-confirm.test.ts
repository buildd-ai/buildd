/**
 * confirmEvidenceUpload: the one place a `pending` runner upload becomes
 * `stored` (or `failed`). Used by the confirm route and the indexer's reaper.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
let updateReturns: Array<Record<string, unknown>> = [];
let updateThrows = false;
let reread: Record<string, unknown> | undefined;

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: async () => {
            if (updateThrows) throw new Error('db down');
            updates.push({ set, where });
            return updateReturns;
          },
        }),
      }),
    }),
    query: { evidenceObjects: { findFirst: async () => reread } },
  },
}));

const { confirmEvidenceUpload } = await import('./evidence-confirm');
const { EvidenceReadError } = await import('./evidence-read');

const dialect = new PgDialect();

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1', workspaceId: 'ws-1', taskId: 't-1', rootTaskId: 't-1', workerId: 'w-1', prNumber: null,
    kind: 'command_output', backendId: 'be-1', objectKey: 'evidence/k/1-0.log.gz', bytes: 120, sha256: null,
    uploadState: 'pending', indexState: 'queued', expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as any;
}

const heads: any[] = [];
function locate(result: (() => any) | { error: any }) {
  return async () => ({
    bucket: 'team-bucket',
    client: {
      send: async (cmd: any) => {
        heads.push({ name: cmd.constructor.name, input: cmd.input });
        if ('error' in (result as any)) throw (result as any).error;
        return (result as () => any)();
      },
    },
  });
}
const notFound = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

beforeEach(() => {
  updates.length = 0;
  heads.length = 0;
  updateReturns = [];
  updateThrows = false;
  reread = undefined;
});

describe('confirmEvidenceUpload', () => {
  it('HEADs the row key on the row backend and marks it stored with the stored size', async () => {
    updateReturns = [{ uploadState: 'stored', bytes: 120 }];
    const r = await confirmEvidenceUpload(row(), { locate: locate(() => ({ ContentLength: 120 })) });
    expect(r).toEqual({ uploadState: 'stored', bytes: 120, changed: true });
    expect(heads).toEqual([{ name: 'HeadObjectCommand', input: { Bucket: 'team-bucket', Key: 'evidence/k/1-0.log.gz' } }]);
    expect(updates[0].set).toMatchObject({ uploadState: 'stored', bytes: 120 });
    // Only a still-pending row is moved: a concurrent confirm cannot flip it back.
    const q = dialect.sqlToQuery(updates[0].where as any);
    expect(q.sql).toContain('"upload_state" = ');
    expect(q.params).toContain('pending');
    expect(q.params).toContain('ev-1');
  });

  it('marks a missing object failed and takes it out of the index queue', async () => {
    updateReturns = [{ uploadState: 'failed', bytes: 120 }];
    const r = await confirmEvidenceUpload(row(), { locate: locate({ error: notFound }) });
    expect(r.uploadState).toBe('failed');
    expect(r.changed).toBe(true);
    expect(updates[0].set).toMatchObject({ uploadState: 'failed', indexState: 'skipped' });
  });

  it('marks a size mismatch failed, never stored', async () => {
    updateReturns = [{ uploadState: 'failed', bytes: 120 }];
    const r = await confirmEvidenceUpload(row(), { locate: locate(() => ({ ContentLength: 999 })) });
    expect(r.uploadState).toBe('failed');
    expect(r.reason).toContain('999');
    expect(updates[0].set.uploadState).toBe('failed');
  });

  it('is idempotent: a row that is no longer pending is returned as-is, with no HEAD and no write', async () => {
    for (const state of ['stored', 'failed', 'unreadable']) {
      const r = await confirmEvidenceUpload(row({ uploadState: state }), { locate: locate(() => ({ ContentLength: 120 })) });
      expect(r).toEqual({ uploadState: state, bytes: 120, changed: false });
    }
    expect(heads).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('reports the winner when another confirm settled the row first', async () => {
    updateReturns = [];
    reread = row({ uploadState: 'stored' });
    const r = await confirmEvidenceUpload(row(), { locate: locate(() => ({ ContentLength: 120 })) });
    expect(r).toEqual({ uploadState: 'stored', bytes: 120, changed: false });
  });

  it('leaves the row pending when the backend cannot be checked', async () => {
    const err = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const r = await confirmEvidenceUpload(row(), { locate: locate({ error: err }) });
    expect(r.uploadState).toBe('pending');
    expect(r.changed).toBe(false);
    expect(updates).toEqual([]);
  });

  it('leaves the row pending when the backend client cannot be built', async () => {
    const r = await confirmEvidenceUpload(row(), { locate: async () => { throw new EvidenceReadError('unreachable', 502); } });
    expect(r.uploadState).toBe('pending');
    expect(updates).toEqual([]);
  });

  it('marks the row unreadable when its backend no longer exists', async () => {
    updateReturns = [{ uploadState: 'unreadable', bytes: 120 }];
    const r = await confirmEvidenceUpload(row(), { locate: async () => { throw new EvidenceReadError('gone', 410); } });
    expect(r.uploadState).toBe('unreadable');
    expect(updates[0].set).toMatchObject({ uploadState: 'unreadable', indexState: 'skipped' });
  });

  it('never throws when the write fails', async () => {
    updateThrows = true;
    const r = await confirmEvidenceUpload(row(), { locate: locate(() => ({ ContentLength: 120 })) });
    expect(r.uploadState).toBe('pending');
    expect(r.changed).toBe(false);
  });
});
