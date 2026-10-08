import { describe, expect, it } from 'bun:test';
import {
  buildWorkspaceRows,
  groupWorkspaceRows,
  INACTIVE_AFTER_DAYS,
  isInactive,
  moveTargets,
  sortByActivity,
  WORKSPACE_DEFAULTS,
  type WorkspaceRow,
} from './rows';

/** No team has stored grants: every check uses the registry defaults. */
const NO_OVERRIDES = new Map();

// Illustrative fixtures only.
const USER = 'user-1';
const NOW = new Date('2026-06-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const team = (id: string, role: string, slug = id) => ({ id, name: `Name ${id}`, slug, role, memberCount: 1 });
const ws = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, teamId: 't1', gitConfig: null, webhookConfig: null, ...extra });

function build(workspaces: ReturnType<typeof ws>[], activity = new Map()) {
  return buildWorkspaceRows({ overrides: NO_OVERRIDES, userId: USER, teams: [team('t1', 'owner')], workspaces: workspaces as never, activity });
}

describe('WORKSPACE_DEFAULTS', () => {
  it('names the values a workspace with no gitConfig gets from the server', () => {
    expect(WORKSPACE_DEFAULTS).toEqual({ gitWorkflow: 'Mission branch', mergePolicy: 'Auto-threshold' });
  });
});

describe('buildWorkspaceRows: what differs from the default', () => {
  it('a workspace on every default shows no differs chips', () => {
    expect(build([ws('w1')]).rows[0].differs).toEqual([]);
  });

  it('shows only the values that differ, each linking to its editor', () => {
    const { rows } = build([
      ws('w1', { gitConfig: { mergePolicy: { tier: 'agent-review' } } }),
      ws('w2', { gitConfig: { branchStrategy: 'direct', mergePolicy: { tier: 'human' }, enforceGreenCI: true } }),
    ]);
    expect(rows[0].differs).toEqual([{ key: 'mergePolicy', label: 'Agent review', href: '/app/settings/workspace/w1' }]);
    expect(rows[1].differs.map((d) => [d.key, d.label, d.href])).toEqual([
      ['gitWorkflow', 'Direct', '/app/workspaces/w2/config'],
      ['mergePolicy', 'Human gate', '/app/settings/workspace/w2'],
      ['ciRetry', 'Fixes until CI passes', '/app/workspaces/w2/config#ci-retry'],
    ]);
  });

  it('an explicit value equal to the default is not a difference', () => {
    const { rows } = build([ws('w1', { gitConfig: { branchStrategy: 'mission-branch', mergePolicy: { tier: 'auto-threshold' }, enforceGreenCI: false } })]);
    expect(rows[0].differs).toEqual([]);
  });
});

describe('buildWorkspaceRows: where work runs', () => {
  it('uses gitConfig.executor, else derives cloud from the dispatch webhook, else any', () => {
    const webhook = { enabled: true, events: ['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled'] };
    const { rows } = build([
      ws('w1', { gitConfig: { executor: 'host' } }),
      ws('w2', { webhookConfig: webhook }),
      ws('w3'),
    ]);
    expect(rows.map((r) => r.runsOn.executor)).toEqual(['host', 'cloud', 'any']);
  });

  it('gives a size only for cloud: explicit, else the stored derivation, else standard', () => {
    const { rows } = build([
      ws('w1', { gitConfig: { executor: 'cloud', runnerSize: 'large' } }),
      ws('w2', { gitConfig: { executor: 'cloud', runnerSizeDerived: { size: 'large', reason: 'low_disk', at: daysAgo(3) } } }),
      ws('w3', { gitConfig: { executor: 'cloud' } }),
      ws('w4', { gitConfig: { executor: 'any', runnerSize: 'large' } }),
    ]);
    expect(rows.map((r) => r.runsOn.size)).toEqual(['large', 'large', 'standard', null]);
  });
});

describe('buildWorkspaceRows: activity and health', () => {
  it('carries the aggregate per workspace, and zeros where a workspace has no tasks', () => {
    const activity = new Map([['w1', { lastTaskAt: daysAgo(1), openTasks: 4, stuckTasks: 1, redPrs: 2 }]]);
    const { rows } = build([ws('w1'), ws('w2')], activity);
    expect(rows[0]).toMatchObject({ lastActivityAt: daysAgo(1), openTasks: 4, health: { stuckTasks: 1, redPrs: 2 } });
    expect(rows[1]).toMatchObject({ lastActivityAt: null, openTasks: 0, health: { stuckTasks: 0, redPrs: 0 } });
  });

  it('normalises a Date from the driver to an ISO string', () => {
    const activity = new Map([['w1', { lastTaskAt: new Date(daysAgo(2)), openTasks: 0, stuckTasks: 0, redPrs: 0 }]]);
    expect(build([ws('w1')], activity).rows[0].lastActivityAt).toBe(daysAgo(2));
  });
});

describe('buildWorkspaceRows: permissions', () => {
  it('allows a move only when the user administers the workspace team and at least one other team', () => {
    const { rows, moveTeams } = buildWorkspaceRows({
      overrides: NO_OVERRIDES,
      userId: USER,
      teams: [team('t1', 'owner'), team('t2', 'admin'), team('t3', 'member')],
      workspaces: [ws('w1'), ws('w3', { teamId: 't3' })] as never,
      activity: new Map(),
    });
    expect(rows.map((r) => [r.id, r.canMove, r.canEdit])).toEqual([['w1', true, true], ['w3', false, false]]);
    expect(moveTeams.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('counts the personal team as administered, and no move with a single admin team', () => {
    const { rows } = buildWorkspaceRows({
      overrides: NO_OVERRIDES,
      userId: USER,
      teams: [team('p', 'member', `personal-${USER}`), team('t3', 'member')],
      workspaces: [ws('w1', { teamId: 'p' })] as never,
      activity: new Map(),
    });
    expect(rows[0]).toMatchObject({ canEdit: true, canMove: false });
  });
});

const row = (id: string, lastActivityAt: string | null, teamId = 't1', teamName = 'Team One'): WorkspaceRow => ({
  id, name: id, teamId, teamName, differs: [], runsOn: { executor: 'any', size: null },
  lastActivityAt, openTasks: 0, health: { stuckTasks: 0, redPrs: 0 }, canEdit: true, canMove: false,
});

describe('sortByActivity', () => {
  it('puts the most recent activity first, never-active last, ties by name', () => {
    const sorted = sortByActivity([row('c', null), row('b', daysAgo(5)), row('a', daysAgo(1)), row('d', daysAgo(5)), row('aa', null)]);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'd', 'aa', 'c']);
  });
});

describe('isInactive', () => {
  it(`is true with no task in ${INACTIVE_AFTER_DAYS} days, or none ever`, () => {
    expect(isInactive(row('a', daysAgo(29)), NOW)).toBe(false);
    expect(isInactive(row('a', daysAgo(31)), NOW)).toBe(true);
    expect(isInactive(row('a', null), NOW)).toBe(true);
  });
});

describe('groupWorkspaceRows', () => {
  it('one team: a single group with no heading, active sorted, inactive split off', () => {
    const { showTeamHeadings, groups } = groupWorkspaceRows([row('old', daysAgo(60)), row('b', daysAgo(3)), row('a', daysAgo(1)), row('never', null)], NOW);
    expect(showTeamHeadings).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].active.map((r) => r.id)).toEqual(['a', 'b']);
    expect(groups[0].inactive.map((r) => r.id)).toEqual(['old', 'never']);
  });

  it('several teams: a heading per team, teams ordered by their latest activity', () => {
    const { showTeamHeadings, groups } = groupWorkspaceRows([
      row('x', daysAgo(10), 't2', 'Team Two'),
      row('y', daysAgo(2), 't1', 'Team One'),
      row('z', null, 't3', 'Team Three'),
    ], NOW);
    expect(showTeamHeadings).toBe(true);
    expect(groups.map((g) => [g.teamName, g.active.length, g.inactive.length])).toEqual([
      ['Team One', 1, 0],
      ['Team Two', 1, 0],
      ['Team Three', 0, 1],
    ]);
  });
});

describe('moveTargets', () => {
  it('returns the administered teams when the workspace can move, else null', () => {
    const teams = [team('t1', 'owner'), team('t2', 'admin'), team('t3', 'member')];
    expect(moveTargets(USER, teams, 't1', NO_OVERRIDES)?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(moveTargets(USER, teams, 't3', NO_OVERRIDES)).toBeNull();
    expect(moveTargets(USER, [team('t1', 'owner'), team('t3', 'member')], 't1', NO_OVERRIDES)).toBeNull();
  });
});
