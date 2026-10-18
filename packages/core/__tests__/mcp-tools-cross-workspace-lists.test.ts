/**
 * list_artifacts, list_schedules and list_skills with no workspace read every
 * reachable workspace in one call (spec 3ef37387 R-22), not one call per
 * workspace.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx = (): ActionContext => ({
  workspaceId: undefined,
  getWorkspaceId: async () => null,
  getLevel: async () => 'admin',
} as unknown as ActionContext);

function api(byPath: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = mock(async (endpoint: string) => {
    calls.push(endpoint);
    const path = new URL(endpoint, 'http://x').pathname;
    if (!(path in byPath)) throw new Error(`unexpected call ${endpoint}`);
    return byPath[path];
  });
  return { fn: fn as unknown as ApiFn, calls };
}

describe('cross-workspace lists', () => {
  it('list_artifacts: one read, workspace names from the rows, filters passed through', async () => {
    const { fn, calls } = api({
      '/api/workspaces/across/artifacts': {
        workspaceCount: 2,
        artifacts: [
          { id: 'a1', title: 'Plan', type: 'report', workspaceName: 'alpha', updatedAt: '2026-01-02' },
          { id: 'a2', title: 'Notes', type: 'summary', workspaceName: 'beta', updatedAt: '2026-01-01' },
        ],
      },
    });
    const res = await handleBuilddAction(fn, 'list_artifacts', { type: 'report', review: true }, ctx());
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0], 'http://x');
    expect(url.searchParams.get('type')).toBe('report');
    expect(url.searchParams.get('review')).toBe('true');
    expect(res.content[0].text).toContain('2 artifact(s) across 2 workspace(s)');
    expect(res.content[0].text).toContain('[alpha]');
  });

  it('list_schedules: one read, filters still applied', async () => {
    const schedule = (name: string, ws: string) => ({
      id: name, name, enabled: true, cronExpression: '0 * * * *', timezone: 'UTC', totalRuns: 0,
      consecutiveFailures: 0, taskTemplate: { title: 't' }, workspaceName: ws,
    });
    const { fn, calls } = api({
      '/api/workspaces/across/schedules': { workspaceCount: 2, schedules: [schedule('nightly', 'alpha'), schedule('weekly', 'beta')] },
    });
    const res = await handleBuilddAction(fn, 'list_schedules', { nameContains: 'night' }, ctx());
    expect(calls).toEqual(['/api/workspaces/across/schedules']);
    expect(res.content[0].text).toContain('1 schedule(s) across 2 workspace(s)');
    expect(res.content[0].text).toContain('[alpha]');
  });

  it('list_skills: one read, team-level rows once', async () => {
    const { fn, calls } = api({
      '/api/workspaces/across/skills': {
        workspaceCount: 2,
        skills: [
          { slug: 'builder', name: 'Builder', workspaceId: null, isRole: true, enabled: true, model: 'inherit' },
          { slug: 'builder', name: 'Builder', workspaceId: null, isRole: true, enabled: true, model: 'inherit' },
          { slug: 'qa', name: 'QA', workspaceId: 'w2', workspaceName: 'beta', isRole: false, enabled: true, model: 'inherit' },
        ],
      },
    });
    const res = await handleBuilddAction(fn, 'list_skills', { isRole: true }, ctx());
    expect(calls).toEqual(['/api/workspaces/across/skills?isRole=true']);
    expect(res.content[0].text).toContain('2 skill(s) across 2 workspace(s)');
    expect(res.content[0].text).toContain('— beta');
  });

  it('says so when the caller reaches no workspace', async () => {
    const { fn } = api({ '/api/workspaces/across/schedules': { workspaceCount: 0, schedules: [] } });
    const res = await handleBuilddAction(fn, 'list_schedules', {}, ctx());
    expect(res.content[0].text).toBe('No workspaces found.');
  });
});
