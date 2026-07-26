import { describe, it, expect, mock } from 'bun:test';
import {
  verifyLinearSignature,
  parseLinearIssueEvent,
  handleLinearIssueEvent,
} from './linear-webhook';

// Deliberately NO mock.module of '@buildd/core/*' or 'drizzle-orm' — those leak
// globally across bun test files and corrupt sibling tests. The DB boundary is a
// hand-rolled recording mock; link helpers are injected.

/** Compute a valid Linear-style HMAC-SHA256 hex signature over a body. */
async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recording mock db. insert→values→returning, update→set→where→returning,
 * delete→where all capture their args and resolve with a scripted result.
 */
function makeDb(opts?: { insertReturning?: any[]; updateReturning?: any[] }) {
  const calls: any = { insert: null, update: null, delete: null };
  return {
    calls,
    insert() {
      return {
        values(v: any) {
          calls.insert = { values: v };
          return { returning: async () => opts?.insertReturning ?? [{ id: 'task-new' }] };
        },
      };
    },
    update() {
      return {
        set(s: any) {
          calls.update = { set: s, where: undefined };
          return {
            where(w: any) {
              calls.update.where = w;
              return { returning: async () => opts?.updateReturning ?? [{ id: 'task-1' }] };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(w: any) {
          calls.delete = { where: w };
          return Promise.resolve();
        },
      };
    },
  } as any;
}

const ctx = { workspaceId: 'ws-1', teamId: 'team-1' };

describe('verifyLinearSignature', () => {
  it('accepts a correct HMAC over the raw body', async () => {
    const body = JSON.stringify({ type: 'Issue', action: 'update' });
    const sig = await sign(body, 'shh');
    expect(await verifyLinearSignature(body, sig, 'shh')).toBe(true);
  });

  it('rejects a wrong secret, tampered body, and missing inputs', async () => {
    const body = JSON.stringify({ type: 'Issue' });
    const sig = await sign(body, 'shh');
    expect(await verifyLinearSignature(body, sig, 'other')).toBe(false);
    expect(await verifyLinearSignature(body + 'x', sig, 'shh')).toBe(false);
    expect(await verifyLinearSignature(body, null, 'shh')).toBe(false);
    expect(await verifyLinearSignature(body, sig, null)).toBe(false);
  });
});

describe('parseLinearIssueEvent', () => {
  const labeled = {
    type: 'Issue',
    action: 'update',
    data: {
      id: 'uuid-1',
      identifier: 'ACM-42',
      title: 'Fix the thing',
      url: 'https://linear.app/acme/issue/ACM-42/fix',
      labels: [{ name: 'other' }, { name: 'Buildd' }],
    },
  };

  it('classifies a labeled issue as "label" (case-insensitive)', () => {
    expect(parseLinearIssueEvent(labeled, 'buildd')).toEqual({
      kind: 'label',
      issueId: 'uuid-1',
      issueUrl: 'https://linear.app/acme/issue/ACM-42/fix',
      title: 'Fix the thing',
    });
  });

  it('ignores an issue whose labels do not include the trigger label', () => {
    expect(parseLinearIssueEvent(labeled, 'triage')).toEqual({ kind: 'ignore' });
  });

  it('classifies a completed/canceled state or a remove action as "close" (precedence over label)', () => {
    const done = { ...labeled, data: { ...labeled.data, state: { type: 'completed' } } };
    expect(parseLinearIssueEvent(done, 'buildd').kind).toBe('close');
    const canceled = { ...labeled, data: { ...labeled.data, state: { type: 'canceled' } } };
    expect(parseLinearIssueEvent(canceled, 'buildd').kind).toBe('close');
    const removed = { type: 'Issue', action: 'remove', data: { id: 'uuid-1' } };
    expect(parseLinearIssueEvent(removed, 'buildd').kind).toBe('close');
  });

  it('ignores non-Issue payloads and payloads without a data id', () => {
    expect(parseLinearIssueEvent({ type: 'Project', action: 'update', data: { id: 'p1' } }, 'buildd').kind).toBe('ignore');
    expect(parseLinearIssueEvent({ type: 'Issue', action: 'update', data: {} }, 'buildd').kind).toBe('ignore');
  });

  it('reads labels from a nodes[] collection shape too', () => {
    const nodesShape = {
      type: 'Issue',
      action: 'create',
      data: { id: 'u2', title: 'T', url: 'x', labels: { nodes: [{ name: 'buildd' }] } },
    };
    expect(parseLinearIssueEvent(nodesShape, 'buildd').kind).toBe('label');
  });
});

describe('handleLinearIssueEvent — label (create + idempotency)', () => {
  it('creates one linked task when no link exists', async () => {
    const db = makeDb({ insertReturning: [{ id: 'task-new' }] });
    const findLink = mock(async () => null);
    const linkExternal = mock(async () => ({ builddEntityId: 'task-new', builddEntityType: 'task' }) as any);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'label', issueId: 'uuid-1', issueUrl: 'https://linear.app/x', title: 'T' },
      { findLink, linkExternal },
    );
    expect(res).toEqual({ action: 'created', taskId: 'task-new' });
    expect(db.calls.insert.values).toMatchObject({
      workspaceId: 'ws-1',
      title: 'T',
      externalIssueId: 'uuid-1',
      externalIssueUrl: 'https://linear.app/x',
      creationSource: 'webhook',
    });
    expect(linkExternal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ provider: 'linear', builddEntityType: 'task', externalId: 'uuid-1', builddEntityId: 'task-new' }),
    );
    expect(db.calls.delete).toBeNull();
  });

  it('does not create a second task when a task link already exists (AC-2)', async () => {
    const db = makeDb();
    const findLink = mock(async () => ({ builddEntityId: 'task-existing', builddEntityType: 'task' }) as any);
    const linkExternal = mock(async () => ({}) as any);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'label', issueId: 'uuid-1', issueUrl: null, title: 'T' },
      { findLink, linkExternal },
    );
    expect(res).toEqual({ action: 'exists', taskId: 'task-existing' });
    expect(db.calls.insert).toBeNull();
    expect(linkExternal).not.toHaveBeenCalled();
  });

  it('deletes the loser task when a concurrent delivery won the upsert', async () => {
    const db = makeDb({ insertReturning: [{ id: 'task-loser' }] });
    const findLink = mock(async () => null); // both deliveries pass the pre-check
    const linkExternal = mock(async () => ({ builddEntityId: 'task-winner', builddEntityType: 'task' }) as any);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'label', issueId: 'uuid-1', issueUrl: null, title: 'T' },
      { findLink, linkExternal },
    );
    expect(res).toEqual({ action: 'exists', taskId: 'task-winner' });
    expect(db.calls.delete).not.toBeNull();
  });
});

describe('handleLinearIssueEvent — close (guarded cancel)', () => {
  it('cancels an open linked task', async () => {
    const db = makeDb({ updateReturning: [{ id: 'task-1' }] });
    const findLink = mock(async () => ({ builddEntityId: 'task-1', builddEntityType: 'task' }) as any);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'close', issueId: 'uuid-1', issueUrl: null, title: 'T' },
      { findLink },
    );
    expect(res).toEqual({ action: 'cancelled', taskId: 'task-1' });
    expect(db.calls.update.set).toMatchObject({ status: 'cancelled' });
  });

  it('leaves an already-terminal task unchanged — 0 rows updated (AC-3)', async () => {
    const db = makeDb({ updateReturning: [] });
    const findLink = mock(async () => ({ builddEntityId: 'task-done', builddEntityType: 'task' }) as any);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'close', issueId: 'uuid-1', issueUrl: null, title: 'T' },
      { findLink },
    );
    expect(res).toEqual({ action: 'noop', taskId: 'task-done' });
  });

  it('ignores a close for an unknown issue', async () => {
    const db = makeDb();
    const findLink = mock(async () => null);
    const res = await handleLinearIssueEvent(
      db,
      ctx,
      { kind: 'close', issueId: 'uuid-x', issueUrl: null, title: 'T' },
      { findLink },
    );
    expect(res).toEqual({ action: 'ignored' });
    expect(db.calls.update).toBeNull();
  });
});

describe('handleLinearIssueEvent — ignore', () => {
  it('does nothing for an ignore event', async () => {
    const db = makeDb();
    const res = await handleLinearIssueEvent(db, ctx, { kind: 'ignore' }, {});
    expect(res).toEqual({ action: 'ignored' });
    expect(db.calls.insert).toBeNull();
    expect(db.calls.update).toBeNull();
  });
});
