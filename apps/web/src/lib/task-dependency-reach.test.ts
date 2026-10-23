import { describe, expect, it } from 'bun:test';
import {
  checkDependencyCycle,
  checkDependencyReach,
  dependencyViewerOf,
  HIDDEN_TASK_WORDS,
  MAX_CYCLE_WALK,
  resolveDependencyHolders,
  UNREACHABLE_DEPENDENCY_ERROR,
  type DependencyViewer,
  type ReachIo,
  type ReachTaskRow,
} from './task-dependency-reach';

// Made-up fixture: one team with two workspaces, and a workspace of another team.
const W1 = 'ws-one';
const W2 = 'ws-two';
const OTHER = 'ws-other-team';
const TEAM = 'team-a';

function row(id: string, workspaceId: string, o: Partial<ReachTaskRow> = {}): ReachTaskRow {
  return {
    id,
    title: `Title ${id}`,
    workspaceId,
    workspaceName: workspaceId === W1 ? 'Docs' : workspaceId === W2 ? 'App' : 'Elsewhere',
    teamId: workspaceId === OTHER ? 'team-b' : TEAM,
    dependsOn: [],
    ...o,
  };
}

function io(rows: ReachTaskRow[], seen: (viewer: DependencyViewer, ws: string) => boolean): ReachIo & { loads: string[][] } {
  const byId = new Map(rows.map(r => [r.id, r]));
  const loads: string[][] = [];
  return {
    loads,
    loadTasks: async (ids) => {
      loads.push([...ids]);
      return ids.map(id => byId.get(id)).filter((r): r is ReachTaskRow => !!r);
    },
    sees: async (viewer, ws) => seen(viewer, ws),
  };
}

const person: DependencyViewer = { kind: 'person', userId: 'user-1' };
const keyW2: DependencyViewer = { kind: 'account', account: { id: 'acc-1' } as any };
const token: DependencyViewer = { kind: 'account', account: { id: 'acc-1', taskScope: { taskId: 't', workspaceId: W2, expiresAt: 0 } } as any };
const seesTeam = (_v: DependencyViewer, ws: string) => ws !== OTHER;
const seesW2Only = (_v: DependencyViewer, ws: string) => ws === W2;

describe('dependencyViewerOf', () => {
  it('a key or token wins over a session, as the routes decide the caller', () => {
    expect(dependencyViewerOf({ id: 'u' }, { id: 'a' } as any)).toEqual({ kind: 'account', account: { id: 'a' } as any });
    expect(dependencyViewerOf({ id: 'u' }, null)).toEqual({ kind: 'person', userId: 'u' });
  });
});

describe('checkDependencyReach (R-1 to R-3)', () => {
  it('AC-1: a team member may depend on a task in another workspace of the team', async () => {
    const r = await checkDependencyReach({ viewer: person, teamId: TEAM, ids: ['a'] }, io([row('a', W1)], seesTeam));
    expect(r).toEqual({ ok: true });
  });

  it('AC-2: a task in another team reads exactly like an unknown id', async () => {
    const x = await checkDependencyReach({ viewer: person, teamId: TEAM, ids: ['x'] }, io([row('x', OTHER)], () => true));
    const missing = await checkDependencyReach({ viewer: person, teamId: TEAM, ids: ['x'] }, io([], () => true));
    expect(x).toEqual(missing);
    expect(x).toEqual({ ok: false, error: `${UNREACHABLE_DEPENDENCY_ERROR}: x`, ids: ['x'] });
  });

  it('AC-3: a per-task token reaches only its own workspace, whatever else it is granted', async () => {
    const tokenWithDelegation: DependencyViewer = {
      kind: 'account',
      account: { id: 'acc-1', taskScope: { taskId: 't', workspaceId: W2, expiresAt: 0, delegations: [{ workspaceId: W1, capabilities: ['tasks:create', 'analytics:read'] }] } } as any,
    };
    // The default io decides a token by its own workspace; a fake `sees` that
    // says yes must not widen it.
    const r = await checkDependencyReach({ viewer: tokenWithDelegation, teamId: TEAM, ids: ['a', 'c'] }, io([row('a', W1), row('c', W2)], () => true));
    expect(r).toEqual({ ok: false, error: `${UNREACHABLE_DEPENDENCY_ERROR}: a`, ids: ['a'] });
  });

  it('an account key must reach the upstream workspace', async () => {
    const r = await checkDependencyReach({ viewer: keyW2, teamId: TEAM, ids: ['a', 'c'] }, io([row('a', W1), row('c', W2)], seesW2Only));
    expect(r).toEqual({ ok: false, error: `${UNREACHABLE_DEPENDENCY_ERROR}: a`, ids: ['a'] });
    expect(await checkDependencyReach({ viewer: keyW2, teamId: TEAM, ids: ['c'] }, io([row('c', W2)], seesW2Only))).toEqual({ ok: true });
  });

  it('no ids reads nothing', async () => {
    const fake = io([], () => true);
    expect(await checkDependencyReach({ viewer: person, teamId: TEAM, ids: [] }, fake)).toEqual({ ok: true });
    expect(fake.loads).toEqual([]);
  });

  it('a token still reaches a task of its own workspace', async () => {
    expect(await checkDependencyReach({ viewer: token, teamId: TEAM, ids: ['c'] }, io([row('c', W2)], () => false))).toEqual({ ok: true });
  });
});

describe('resolveDependencyHolders (R-6 to R-9)', () => {
  it('names a visible upstream in another workspace with its workspace; same-workspace ones as today', async () => {
    const m = await resolveDependencyHolders({ viewer: person, teamId: TEAM, dependentWorkspaceId: W2 }, ['a', 'c'], io([row('a', W1), row('c', W2)], seesTeam));
    expect(m.get('a')).toEqual({ id: 'a', hidden: false, title: 'Title a', workspaceId: W1, workspaceName: 'Docs' });
    expect(m.get('c')).toEqual({ id: 'c', hidden: false, title: 'Title c', workspaceId: W2, workspaceName: null });
  });

  it('hides an upstream the viewer cannot see: no title and no workspace', async () => {
    const m = await resolveDependencyHolders({ viewer: keyW2, teamId: TEAM, dependentWorkspaceId: W2 }, ['a'], io([row('a', W1)], seesW2Only));
    expect(m.get('a')).toEqual({ id: 'a', hidden: true, title: null, workspaceId: null, workspaceName: null });
  });

  it('a member surface sees every workspace of the dependent team and none outside it', async () => {
    const m = await resolveDependencyHolders({ viewer: { kind: 'member' }, teamId: TEAM, dependentWorkspaceId: W2 }, ['a', 'x'], io([row('a', W1), row('x', OTHER)], () => false));
    expect(m.get('a')!.hidden).toBe(false);
    expect(m.get('x')!.hidden).toBe(true);
  });

  it('an id with no row is absent: callers keep their own missing-row reading', async () => {
    const m = await resolveDependencyHolders({ viewer: person, teamId: TEAM, dependentWorkspaceId: W2 }, ['gone'], io([], seesTeam));
    expect(m.has('gone')).toBe(false);
  });

  it('the words for a hidden upstream', () => {
    expect(HIDDEN_TASK_WORDS).toBe("a task in a workspace you can't see");
  });
});

describe('checkDependencyCycle (R-16)', () => {
  it('AC-12: B depending on A, which depends on B across workspaces, is a cycle naming A', async () => {
    const rows = [row('a', W1, { dependsOn: ['b'] }), row('b', W2)];
    const r = await checkDependencyCycle({ viewer: person, teamId: TEAM, taskId: 'b', dependsOn: ['a'] }, io(rows, seesTeam));
    expect(r).toEqual({ ok: false, error: 'would create a dependency cycle through "Title a"' });
  });

  it('counts the tasks on the cycle the caller cannot see, never naming them', async () => {
    // b -> a (W1, hidden) -> h (W1, hidden) -> v (W2) -> b
    const rows = [
      row('a', W1, { dependsOn: ['h'] }),
      row('h', W1, { dependsOn: ['v'] }),
      row('v', W2, { dependsOn: ['b'] }),
      row('b', W2),
    ];
    const r = await checkDependencyCycle({ viewer: keyW2, teamId: TEAM, taskId: 'b', dependsOn: ['a'] }, io(rows, seesW2Only));
    expect(r).toEqual({ ok: false, error: `would create a dependency cycle through "Title v" and 2 tasks in workspaces you can't see` });
    expect((r as { error: string }).error).not.toContain('Title a');
    expect((r as { error: string }).error).not.toContain('Title h');
  });

  it('one hidden task reads in the singular', async () => {
    const rows = [row('a', W1, { dependsOn: ['b'] }), row('b', W2)];
    const r = await checkDependencyCycle({ viewer: keyW2, teamId: TEAM, taskId: 'b', dependsOn: ['a'] }, io(rows, seesW2Only));
    expect(r).toEqual({ ok: false, error: `would create a dependency cycle through 1 task in a workspace you can't see` });
  });

  it('a chain that never returns is fine; a diamond is not a cycle', async () => {
    const rows = [row('a', W1, { dependsOn: ['c', 'd'] }), row('c', W1, { dependsOn: ['e'] }), row('d', W2, { dependsOn: ['e'] }), row('e', W2)];
    expect(await checkDependencyCycle({ viewer: person, teamId: TEAM, taskId: 'b', dependsOn: ['a'] }, io(rows, seesTeam))).toEqual({ ok: true });
  });

  it('follows no edge into another team', async () => {
    const rows = [row('a', W1, { dependsOn: ['x'] }), row('x', OTHER, { dependsOn: ['b'] }), row('b', W2)];
    const fake = io(rows, seesTeam);
    expect(await checkDependencyCycle({ viewer: person, teamId: TEAM, taskId: 'b', dependsOn: ['a'] }, fake)).toEqual({ ok: true });
  });

  it('refuses past the bound rather than guessing', async () => {
    const n = MAX_CYCLE_WALK + 5;
    const rows = Array.from({ length: n }, (_, i) => row(`n${i}`, W1, { dependsOn: i + 1 < n ? [`n${i + 1}`] : [] }));
    const r = await checkDependencyCycle({ viewer: person, teamId: TEAM, taskId: 'b', dependsOn: ['n0'] }, io(rows, seesTeam));
    expect(r).toEqual({ ok: false, error: 'dependency chain too long to check' });
  });

  it('no new ids needs no walk', async () => {
    const fake = io([], seesTeam);
    expect(await checkDependencyCycle({ viewer: person, teamId: TEAM, taskId: 'b', dependsOn: [] }, fake)).toEqual({ ok: true });
    expect(fake.loads).toEqual([]);
  });
});
