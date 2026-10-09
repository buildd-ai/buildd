import { describe, expect, it } from 'bun:test';
import { schedulesRedirectTarget } from './schedules-redirect';

/**
 * The cross-workspace Schedules page is retired: a schedule lives where it is
 * configured, on its mission or in the workspace's settings. The old route
 * keeps resolving and lands on the workspace's schedules.
 */
describe('schedulesRedirectTarget', () => {
  const ws = [{ id: 'w1', name: 'alpha' }, { id: 'w2', name: 'beta' }];

  it('a workspace the user can see, named in the link, wins', () => {
    expect(schedulesRedirectTarget({ requested: 'w2', workspaces: ws })).toBe('/app/workspaces/w2/schedules');
  });

  it('a workspace the user cannot see is ignored, never echoed into the path', () => {
    expect(schedulesRedirectTarget({ requested: 'other', workspaces: ws })).toBe('/app/workspaces/w1/schedules');
  });

  it('no workspace named: the first one', () => {
    expect(schedulesRedirectTarget({ requested: null, workspaces: ws })).toBe('/app/workspaces/w1/schedules');
  });

  it('no workspaces at all: Missions, where mission schedules live', () => {
    expect(schedulesRedirectTarget({ requested: null, workspaces: [] })).toBe('/app/missions');
  });
});
