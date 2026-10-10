/**
 * Activity's loader must not starve live work. The recent window (newest
 * roots updated in the last 30 days) misses a root whose only movement is a
 * repair attempt, because a root's updatedAt does not move while its attempt
 * runs. `loadLiveRootIds` adds every open root and the root of every task an
 * agent holds, however old.
 */
import { describe, expect, it, mock } from 'bun:test';

const calls: Array<{ joined: boolean; limit: number }> = [];
let results: unknown[][] = [];
function chain(joined = false): any {
  return {
    from: () => chain(joined),
    innerJoin: () => chain(true),
    where: () => chain(joined),
    orderBy: () => chain(joined),
    limit: (n: number) => { calls.push({ joined, limit: n }); return Promise.resolve(results[joined ? 1 : 0]); },
  };
}
mock.module('@buildd/core/db', () => ({ db: { select: () => chain() } }));

const { liveRootIdsOf, loadLiveRootIds, ACTIVITY_LIVE_ROOT_LIMIT } = await import('./activity-data');

describe('liveRootIdsOf', () => {
  it('maps a live attempt to its root and dedupes, open roots first', () => {
    expect(liveRootIdsOf(['r1', 'r2'], [{ id: 'a1', parentTaskId: 'old-root' }, { id: 'r2', parentTaskId: null }, { id: 'a2', parentTaskId: 'old-root' }]))
      .toEqual(['r1', 'r2', 'old-root']);
  });
});

describe('loadLiveRootIds', () => {
  it('returns the old root an agent is repairing, beside open roots', async () => {
    calls.length = 0;
    results = [[{ id: 'pending-root' }], [{ id: 'repair-attempt', parentTaskId: 'old-root' }]];
    expect(await loadLiveRootIds(['ws'])).toEqual(['pending-root', 'old-root']);
    // Both reads are bounded.
    expect(calls).toEqual([{ joined: false, limit: ACTIVITY_LIVE_ROOT_LIMIT }, { joined: true, limit: ACTIVITY_LIVE_ROOT_LIMIT }]);
  });

  it('reads nothing with no workspaces in scope', async () => {
    calls.length = 0;
    expect(await loadLiveRootIds([])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

const src = await Bun.file(new URL('./activity-data.ts', import.meta.url)).text();
const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

describe('the loader reads live work in scope', () => {
  it('live reads filter by workspace, status and live worker status', () => {
    const body = src.slice(src.indexOf('export async function loadLiveRootIds'));
    expect(body).toContain('inArray(tasksTable.workspaceId, ws)');
    expect(body).toContain('inArray(workers.workspaceId, ws)');
    expect(body).toContain('notInArray(tasksTable.status, [...TERMINAL_TASK_STATUSES])');
    expect(body).toContain('inArray(workers.status, [...LIVE_WORKER_STATUSES])');
  });

  it('the page merges live roots into the recent window, scoped to the same workspaces', () => {
    expect(page).toContain('loadLiveRootIds(wsIds)');
    expect(page).toMatch(/inArray\(tasks\.workspaceId, wsIds\), inArray\(tasks\.id, missingLiveIds\)/);
    expect(page).toContain('const allTasks = [...new Map([...rootTasks, ...childTasks]');
  });

  it('attempts are read newest first, so a cap never drops the live one', () => {
    const child = page.slice(page.indexOf('const childTasks'), page.indexOf('const allTasks'));
    expect(child).toContain('orderBy: [desc(tasks.createdAt)]');
    expect(child).toContain('limit: ACTIVITY_CHILD_LIMIT');
  });

  it('a failed load reaches the view as an error, not as empty data', () => {
    const c = page.slice(page.indexOf('} catch (error) {'));
    expect(c).toContain('loadFailed = true');
    expect(page).toContain('loadError={loadFailed}');
  });
});
