/**
 * `builddWork.file` (kernel-ports.ts) at the task insert: what a filing owes
 * when the row already exists under the kernel's id. A run that died after the
 * insert left a task nobody bound, woke or announced; the next run's filing is
 * answered "not created" and must still carry what the filing owes (its
 * evidence and variant), and announce a task nobody has picked up yet.
 *
 * The database is a stub: one task row per id, an insert that conflicts when
 * the row exists. Its own file, so the stubs replace nothing another test reads.
 */
import { describe, expect, mock, test } from 'bun:test';

const rows = new Map<string, Record<string, unknown>>();
/** Ids another unique index refuses: the insert conflicts with no row under the id. */
const blocked = new Set<string>();
let lastId = '';
const announced: string[] = [];

const realDb = await import('@buildd/core/db');
mock.module('@buildd/core/db', () => ({
  ...realDb,
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const id = String(v.id);
            lastId = id;
            if (rows.has(id) || blocked.has(id)) return [];
            const row = { status: 'pending', ...v };
            rows.set(id, row);
            return [row];
          },
        }),
      }),
    }),
    query: {
      // The adapter asks only for the id it just tried to insert.
      tasks: { findFirst: async () => rows.get(lastId) ?? null },
      workspaces: { findFirst: async () => ({ id: 'w' }) },
    },
  },
}));
const realDispatch = await import('@/lib/dispatch-authority');
mock.module('@/lib/dispatch-authority', () => ({
  ...realDispatch,
  announceTaskCreated: async (task: { id: string }) => { announced.push(task.id); },
}));

const { builddWork } = await import('./kernel-ports');

const req = { role: 'ci_fix', workspaceId: 'w', taskId: 't1', target: { repoFullName: 'acme/x', prNumber: 1 }, lineage: { deliveryId: 'd' }, dedupeKey: 'k' };
const built = { values: { title: 'Fix CI', workspaceId: 'w' }, workspace: { id: 'w' }, variant: 'diagnose', evidence: { failedJobId: 42 } };

describe('builddWork.file when the task already exists under the kernel id', () => {
  test('a new row is announced once and owes its evidence', async () => {
    rows.clear(); announced.length = 0; blocked.clear();
    const after: string[] = [];
    const work = builddWork({ ci_fix: async () => ({ ...built, afterFile: async (r) => { after.push(r.id); } }) });
    expect(await work.file(req)).toEqual({ taskId: 't1', created: true, variant: 'diagnose', evidence: { failedJobId: 42 } });
    expect({ announced, after }).toEqual({ announced: ['t1'], after: ['t1'] });
  });

  test('filed by a run that died before the kernel bound it: still owed its evidence, and announced again while nobody has it', async () => {
    rows.clear(); announced.length = 0; blocked.clear();
    rows.set('t1', { id: 't1', status: 'pending', title: 'Fix CI', workspaceId: 'w' });
    const after: string[] = [];
    const work = builddWork({ ci_fix: async () => ({ ...built, afterFile: async (r) => { after.push(r.id); } }) });
    expect(await work.file(req)).toEqual({ taskId: 't1', created: false, variant: 'diagnose', evidence: { failedJobId: 42 } });
    expect(announced).toEqual(['t1']);
    expect(after).toEqual([]);
  });

  test('a task already picked up is not announced again', async () => {
    rows.clear(); announced.length = 0; blocked.clear();
    rows.set('t1', { id: 't1', status: 'in_progress', title: 'Fix CI', workspaceId: 'w' });
    expect(await builddWork({ ci_fix: async () => built }).file(req)).toEqual({ taskId: 't1', created: false, variant: 'diagnose', evidence: { failedJobId: 42 } });
    expect(announced).toEqual([]);
  });

  test('another index refused the row and no task exists under the id: the effect retries', async () => {
    rows.clear(); announced.length = 0; blocked.clear();
    blocked.add('t1');
    await expect(builddWork({ ci_fix: async () => ({ ...built, refused: 'another CI retry is pending' }) }).file(req)).rejects.toThrow('another CI retry is pending');
    expect(announced).toEqual([]);
  });
});
