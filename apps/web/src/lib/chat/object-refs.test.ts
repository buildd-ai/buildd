import { describe, it, expect } from 'bun:test';
import { refsFromCall, refsFromCalls, MAX_REFS_PER_CALL } from './object-refs';
import { isBuilddObjectRef } from '@buildd/shared';

const call = (method: string, path: string, body: unknown, status = 200) => ({ method, path, status, body });

describe('refsFromCall', () => {
  it('a task list becomes task refs, capped', () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'pending', workspaceId: 'ws' }));
    const refs = refsFromCall(call('GET', '/api/tasks', { tasks }));
    expect(refs).toHaveLength(MAX_REFS_PER_CALL);
    expect(refs[0]).toEqual({ kind: 'task', id: 't0', workspaceId: 'ws', title: 'Task 0', fallbackText: 'Task: Task 0 [pending]' });
    expect(refs.every(isBuilddObjectRef)).toBe(true);
  });

  it('a created mission becomes one mission ref', () => {
    const refs = refsFromCall(call('POST', '/api/missions', { id: 'm1', title: 'Multi-currency billing', status: 'active', workspaceId: 'ws' }));
    expect(refs).toEqual([{ kind: 'mission', id: 'm1', workspaceId: 'ws', title: 'Multi-currency billing', fallbackText: 'Mission: Multi-currency billing [active]' }]);
  });

  it('a task with a waiting worker yields a question ref keyed by the worker id, plus PR refs', () => {
    const refs = refsFromCall(call('GET', '/api/tasks/t1', {
      id: 't1', title: 'Round per line', status: 'in_progress', workspaceId: 'ws', missionId: 'm1',
      workers: [
        { id: 'w1', status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Round per line or per invoice?' } },
        { id: 'w0', status: 'completed', prUrl: 'https://github.com/acme/billing-web/pull/42' },
      ],
    }));
    expect(refs.map(r => r.kind)).toEqual(['question', 'task', 'pr']);
    expect(refs[0]).toMatchObject({ kind: 'question', id: 'w1', taskId: 't1', missionId: 'm1' });
    expect(refs[2]).toMatchObject({ kind: 'pr', id: 'acme/billing-web#42', repo: 'acme/billing-web', prNumber: 42 });
  });

  it('errors and empty bodies yield nothing', () => {
    expect(refsFromCall(call('GET', '/api/tasks', { error: 'nope' }, 403))).toEqual([]);
    expect(refsFromCall(call('GET', '/api/missions', null))).toEqual([]);
  });

  it('schedules and artifacts', () => {
    expect(refsFromCall(call('GET', '/api/workspaces/ws/schedules', { schedules: [{ id: 's1', name: 'Daily 9am', workspaceId: 'ws' }] }))[0])
      .toMatchObject({ kind: 'schedule', id: 's1' });
    expect(refsFromCall(call('GET', '/api/workspaces/ws/artifacts', { artifacts: [{ id: 'a1', title: 'Report' }] }))[0])
      .toMatchObject({ kind: 'artifact', id: 'a1', workspaceId: null });
  });
});

describe('a filed task', () => {
  it('POST /api/tasks returns the task itself, which becomes a live task ref', () => {
    expect(refsFromCall(call('POST', '/api/tasks', { id: 't9', title: 'JPY e2e test', status: 'pending', workspaceId: 'ws' })))
      .toEqual([expect.objectContaining({ kind: 'task', id: 't9', title: 'JPY e2e test', workspaceId: 'ws' })]);
  });
});

describe('releases', () => {
  const rel = (id: string, tasks: unknown[], repo: string | null = 'acme/web') =>
    ({ id, workspaceId: 'ws', repo, tasks });

  it('each shipped PR becomes a PR ref carrying its mission and area for clustering', () => {
    const refs = refsFromCall(call('GET', '/api/releases', { releases: [rel('r1', [
      { taskId: 't1', prNumber: 12, title: 'fix(fx): rates cache', label: null, category: 'bug', missionId: 'm1', missionTitle: 'Multi-currency' },
      { taskId: 't2', prNumber: null, title: 'untracked', label: null, missionId: null, missionTitle: null },
    ])] }));
    expect(refs).toEqual([{
      kind: 'pr', id: 'acme/web#12', workspaceId: 'ws', repo: 'acme/web', prNumber: 12, url: 'https://github.com/acme/web/pull/12',
      taskId: 't1', title: 'fix(fx): rates cache', missionId: 'm1', missionTitle: 'Multi-currency', area: 'fx', category: 'bug',
      fallbackText: 'PR acme/web#12: fix(fx): rates cache',
    }]);
    expect(refs.every(isBuilddObjectRef)).toBe(true);
  });

  it('no repo, no PR refs; a week of PRs is not cut to the card cap', () => {
    expect(refsFromCall(call('GET', '/api/releases', { releases: [rel('r1', [{ prNumber: 1, title: 'x' }], null)] }))).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ taskId: `t${i}`, prNumber: i + 1, title: `PR ${i}` }));
    expect(refsFromCalls([call('GET', '/api/releases', { releases: [rel('r1', many)] })])).toHaveLength(20);
  });
});

describe('refsFromCalls', () => {
  it('dedupes by kind and id across calls', () => {
    const refs = refsFromCalls([
      call('GET', '/api/missions', { missions: [{ id: 'm1', title: 'A' }] }),
      call('GET', '/api/missions/m1', { id: 'm1', title: 'A' }),
    ]);
    expect(refs).toHaveLength(1);
  });
});
