/**
 * team-service-status AC-10 and AC-11: the loader feeding Home.
 *
 * AC-10: a runner with a recorded sign-in failure and tasks waiting on it
 * gives its owner one "Runner needs sign-in" card, the waiting tasks' own
 * failed cards go, and Needs You rises by one for the owner and by zero for
 * anyone else. Composed from the same pieces Home composes.
 *
 * AC-11: a loader that throws leaves Home with every other item and no status.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { buildActionQueue, buildFailedTaskItems, isActionableChip, type FailedTaskCandidate } from './action-queue';
import { deriveHomeNeedsYou } from './home-needs-you';
import { EMPTY_SERVICE_STATUS, loadServiceStatus, serviceStatusView, type ServiceStatusView } from './service-status-loader';
import { ADMIN, MEMBER, OWNER, TEAM, facts, patternRecord, runner, runnerRecord, task } from './service-status-fixtures';

const BANNED = /incident|sentinel|failure.?rate|baseline|account[ _-]?id|redact|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\bpattern\b|stranded_gate|runner-1|credential:/i;
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).filter(([k]) => k !== 'key' && k !== 'href' && k !== 'taskId').flatMap(([, x]) => strings(x)) : [];

/** Home's failed tasks this build: three hit the runner's sign-in, one failed for its own reason. */
const failedRows: FailedTaskCandidate[] = ['t1', 't2', 't3', 't9'].map(id => ({
  taskId: id, title: `Task ${id}`, status: 'failed', backend: 'claude',
  workerError: 'Not logged in · Please run /login', missionId: null, missionTitle: null, workspaceId: 'ws-1',
}));

/** Home's composition: failed cards (minus linked ones), the queue, then the one Needs You list. */
function homeNeedsYou(status: ServiceStatusView) {
  const queue = buildActionQueue(buildFailedTaskItems(failedRows, { linkedTaskIds: status.linkedTaskIds }), []);
  return deriveHomeNeedsYou({ queue, missions: [], questions: [], held: [], isActionable: isActionableChip, status: status.needsYou });
}

const port = (f = facts()) => ({ facts: async () => f });

describe('AC-10: a runner sign-in failure on Home', () => {
  it('the owner gets one "Runner needs sign-in" card and no failed cards for the waiting tasks', async () => {
    const home = homeNeedsYou(await loadServiceStatus({ userId: OWNER, teamId: TEAM }, port()));
    const signIn = home.items.filter(i => i.title === 'Runner needs sign-in');
    expect(signIn).toHaveLength(1);
    expect(signIn[0].primary).toEqual({ label: 'Sign in on Runner A', href: '/app/settings/runners' });
    const failedTaskIds = home.items.flatMap(i => i.queue?.taskId ? [i.queue.taskId] : []);
    expect(failedTaskIds).not.toContain('t1');
    expect(failedTaskIds).not.toContain('t2');
    expect(failedTaskIds).not.toContain('t3');
  });

  it('Needs You rises by exactly one for the owner and by zero for anyone else', async () => {
    const without = homeNeedsYou({ ...EMPTY_SERVICE_STATUS, linkedTaskIds: new Set(['t1', 't2', 't3']) }).count;
    expect(homeNeedsYou(await loadServiceStatus({ userId: OWNER, teamId: TEAM }, port())).count).toBe(without + 1);
    expect(homeNeedsYou(await loadServiceStatus({ userId: ADMIN, teamId: TEAM }, port())).count).toBe(without);
    expect(homeNeedsYou(await loadServiceStatus({ userId: MEMBER, teamId: TEAM }, port())).count).toBe(without);
  });

  it('a failed task with no active cause keeps its own card', async () => {
    const home = homeNeedsYou(await loadServiceStatus({ userId: ADMIN, teamId: TEAM }, port()));
    expect(home.items.some(i => i.queue?.taskId === 't9')).toBe(true);
  });

  it('a restored cause links nothing and adds no card', async () => {
    const restored = facts({ records: [runnerRecord('credential_expired', ['t1'], { verifiedRestoredAt: '2026-10-12T09:00:00.000Z' })] });
    const v = await loadServiceStatus({ userId: OWNER, teamId: TEAM }, port(restored));
    expect(v.statuses).toEqual([]);
    expect(v.needsYou).toEqual([]);
    expect(v.linkedTaskIds.size).toBe(0);
  });

  it('an unknown cause links no failed task: its cards stay, under a generic status', () => {
    const v = serviceStatusView(facts({ records: [patternRecord('repeated_failure', 'unknown', ['t1'])] }), ADMIN);
    expect(v.linkedTaskIds.size).toBe(0);
    expect(v.statuses).toHaveLength(1);
  });

  it('completed or cancelled tasks are not "waiting" work', () => {
    const v = serviceStatusView(facts({ tasks: [task('t1', MEMBER, { status: 'completed' }), task('t2', OWNER), task('t3', ADMIN, { status: 'cancelled' })] }), OWNER);
    expect(v.statuses[0].work.map(w => w.taskId)).toEqual(['t2']);
    expect(v.statuses[0].effect).toBe('1 task is waiting');
  });
});

describe('banner', () => {
  it('raised for everyone but the holder when the broken runner is most of the team\'s', () => {
    const solo = facts({ runners: [runner()] });
    expect(serviceStatusView(solo, ADMIN).banner?.title).toBe('Runner A is waiting for its owner to sign in');
    expect(serviceStatusView(solo, MEMBER).banner?.title).toBe('Waiting for runner sign-in');
    // The holder has the card; one cause, one item.
    expect(serviceStatusView(solo, OWNER).banner).toBeNull();
    expect(serviceStatusView(solo, OWNER).needsYou).toHaveLength(1);
  });

  it('not raised while other runners still take the work', () => {
    for (const u of [OWNER, ADMIN, MEMBER]) expect(serviceStatusView(facts(), u).banner).toBeNull();
  });

  it('a banner adds nothing to Needs You', () => {
    const v = serviceStatusView(facts({ runners: [runner()] }), MEMBER);
    expect(v.banner).not.toBeNull();
    expect(v.needsYou).toEqual([]);
  });
});

describe('scope and vocabulary', () => {
  it('someone not on the team gets nothing', () => {
    expect(serviceStatusView(facts(), 'user-elsewhere')).toBe(EMPTY_SERVICE_STATUS);
  });

  it('records of another team never reach this team\'s viewers', () => {
    const f = facts({ records: [runnerRecord('credential_expired', ['t1'], { teamId: 'team-b' })] });
    for (const u of [OWNER, ADMIN, MEMBER]) expect(serviceStatusView(f, u).statuses).toEqual([]);
  });

  it('no team-facing string names the machinery, a rule, an id or a rate', () => {
    const f = facts({ records: [runnerRecord('credential_expired', ['t1', 't2']), patternRecord('stranded_gate', 'platform_managed', ['t3']), patternRecord('repeated_failure', 'unknown', ['t9'])] });
    for (const u of [OWNER, ADMIN, MEMBER]) {
      const v = serviceStatusView(f, u);
      for (const s of strings([v.statuses, v.banner, v.needsYou])) expect(s).not.toMatch(BANNED);
    }
  });

  it('one status per cause per viewer, however many tasks it hit', () => {
    const many = facts({ records: [runnerRecord('credential_expired', Array.from({ length: 40 }, (_, i) => `t${i}`))] });
    for (const u of [OWNER, ADMIN, MEMBER]) expect(serviceStatusView(many, u).statuses.length).toBeLessThanOrEqual(1);
  });
});

describe('AC-11: the loader fails', () => {
  it('returns no status and logs; it never throws', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const v = await loadServiceStatus({ userId: OWNER, teamId: TEAM }, { facts: async () => { throw new Error('db down'); } });
    expect(v).toBe(EMPTY_SERVICE_STATUS);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('Home renders every other item and no status', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const v = await loadServiceStatus({ userId: OWNER, teamId: TEAM }, { facts: async () => { throw new Error('db down'); } });
    const home = homeNeedsYou(v);
    // Without a cause to link them, every failed task keeps its card; nothing about service status shows.
    expect(home.items.some(i => i.key.startsWith('service-status:'))).toBe(false);
    expect(home.count).toBe(homeNeedsYou(EMPTY_SERVICE_STATUS).count);
    expect(home.count).toBeGreaterThan(0);
  });

  it('no user or team reads nothing', async () => {
    let called = false;
    const p = { facts: async () => { called = true; return facts(); } };
    expect(await loadServiceStatus({ userId: null, teamId: TEAM }, p)).toBe(EMPTY_SERVICE_STATUS);
    expect(await loadServiceStatus({ userId: OWNER, teamId: null }, p)).toBe(EMPTY_SERVICE_STATUS);
    expect(called).toBe(false);
  });
});

describe('Home, Health and the task page read the loader', () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

  it('Home: one read per render, failed cards skip linked tasks, status cards join the one list, one banner', async () => {
    const home = await read('../app/app/(protected)/home/page.tsx');
    expect(home.match(/loadServiceStatus\(/g)).toHaveLength(1);
    expect(home).toContain('linkedTaskIds: serviceStatus.linkedTaskIds');
    expect(home).toContain('status: serviceStatus.needsYou');
    expect(home).toContain('<ServiceStatusBanner status={serviceStatus.banner}');
  });

  it('Health: the banner on every page, the list on Overview', async () => {
    const health = await read('../app/app/(protected)/health/_lib/render-health.tsx');
    expect(health).toContain('loadServiceStatus(');
    expect(health).toContain('<ServiceStatusBanner status={status.banner} />');
    expect(health).toContain("page === 'overview' && <ServiceStatusList");
  });

  it('task page: only the statuses whose work includes this task', async () => {
    const page = await read('../app/app/(protected)/tasks/[id]/page.tsx');
    expect(page).toContain('s.work.some((w) => w.taskId === task.id)');
    expect(page).toContain('<ServiceStatusList statuses={taskServiceStatus}');
  });
});
