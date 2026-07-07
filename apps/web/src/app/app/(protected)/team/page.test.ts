import { describe, it, expect } from 'bun:test';

// Logic extracted from team/page.tsx for testability.
// Maps active workers to roles and counts attributions.

type WorkerInput = {
  id: string;
  status: string;
  startedAt: Date | null;
  task: {
    id: string;
    title: string;
    roleSlug: string | null;
    context: Record<string, unknown> | null;
    workspace?: { name: string };
    mission?: { title: string } | null;
  } | null;
  prUrl?: string | null;
};

type RoleActivityEntry = {
  count: number;
  task: {
    id: string;
    title: string;
    workspaceName: string;
    workerStatus: string;
    startedAt: string;
    prUrl?: string;
    missionTitle?: string;
  };
};

function buildRoleActivity(
  activeWorkers: WorkerInput[],
  timeAgo: (d: Date | string) => string,
): { roleActivity: Record<string, RoleActivityEntry>; totalActiveWorkerCount: number } {
  const roleActivity: Record<string, RoleActivityEntry> = {};

  for (const w of activeWorkers) {
    const task = w.task;
    if (!task) continue;
    const roleSlug = task.roleSlug;
    const skillSlugs = (task.context?.skillSlugs as string[] | undefined);
    const slugs = roleSlug ? [roleSlug] : (skillSlugs || []);
    for (const slug of slugs) {
      if (!roleActivity[slug]) {
        roleActivity[slug] = {
          count: 0,
          task: {
            id: task.id,
            title: task.title,
            workspaceName: task.workspace?.name || 'Unknown',
            workerStatus: w.status,
            startedAt: w.startedAt ? timeAgo(w.startedAt) : '',
            prUrl: w.prUrl || undefined,
            missionTitle: task.mission?.title || undefined,
          },
        };
      }
      roleActivity[slug].count++;
    }
  }

  return { roleActivity, totalActiveWorkerCount: activeWorkers.length };
}

const noopTimeAgo = () => '1m ago';

describe('buildRoleActivity', () => {
  it('attributes a worker with roleSlug to that role', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'Fix bug', roleSlug: 'builder', context: null } },
    ];
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity(workers, noopTimeAgo);
    expect(Object.keys(roleActivity)).toEqual(['builder']);
    expect(roleActivity['builder'].count).toBe(1);
    expect(totalActiveWorkerCount).toBe(1);
  });

  it('attributes multiple workers with the same roleSlug — count reflects all', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'Task A', roleSlug: 'builder', context: null } },
      { id: 'w2', status: 'starting', startedAt: null, task: { id: 't2', title: 'Task B', roleSlug: 'builder', context: null } },
    ];
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity(workers, noopTimeAgo);
    expect(roleActivity['builder'].count).toBe(2);
    expect(totalActiveWorkerCount).toBe(2);
  });

  it('falls back to context.skillSlugs when roleSlug is null', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'Task', roleSlug: null, context: { skillSlugs: ['researcher'] } } },
    ];
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity(workers, noopTimeAgo);
    expect(roleActivity['researcher'].count).toBe(1);
    expect(totalActiveWorkerCount).toBe(1);
  });

  it('leaves roleActivity empty when tasks have neither roleSlug nor skillSlugs — totalActiveWorkerCount is still accurate', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'Unattributed task', roleSlug: null, context: null } },
      { id: 'w2', status: 'running', startedAt: null, task: { id: 't2', title: 'Another unattributed', roleSlug: null, context: {} } },
    ];
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity(workers, noopTimeAgo);
    // No role attribution — this is the exact scenario that caused Team to show
    // "Idle — No active tasks" while Activity simultaneously showed running tasks.
    expect(Object.keys(roleActivity)).toHaveLength(0);
    // But the total count must still reflect the real state so the header is honest.
    expect(totalActiveWorkerCount).toBe(2);
  });

  it('attributes to multiple slugs when context.skillSlugs has more than one entry', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'Multi-role', roleSlug: null, context: { skillSlugs: ['organizer', 'builder'] } } },
    ];
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity(workers, noopTimeAgo);
    expect(roleActivity['organizer'].count).toBe(1);
    expect(roleActivity['builder'].count).toBe(1);
    expect(totalActiveWorkerCount).toBe(1);
  });

  it('records the first matched task on the entry', () => {
    const workers: WorkerInput[] = [
      { id: 'w1', status: 'running', startedAt: null, task: { id: 't1', title: 'First', roleSlug: 'builder', context: null, workspace: { name: 'Acme' } } },
      { id: 'w2', status: 'running', startedAt: null, task: { id: 't2', title: 'Second', roleSlug: 'builder', context: null } },
    ];
    const { roleActivity } = buildRoleActivity(workers, noopTimeAgo);
    expect(roleActivity['builder'].task.title).toBe('First');
    expect(roleActivity['builder'].task.workspaceName).toBe('Acme');
    expect(roleActivity['builder'].count).toBe(2);
  });

  it('returns zero totalActiveWorkerCount and empty roleActivity when there are no active workers', () => {
    const { roleActivity, totalActiveWorkerCount } = buildRoleActivity([], noopTimeAgo);
    expect(Object.keys(roleActivity)).toHaveLength(0);
    expect(totalActiveWorkerCount).toBe(0);
  });
});
