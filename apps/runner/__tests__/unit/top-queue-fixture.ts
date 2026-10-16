/**
 * A fixed queue for the Queue view tests (spec c7410e76 R-26): two teams, one
 * with estimates on, a plan-limit hold the runner's last claim saw, a start
 * time, a dependency on the row above, and waiting work that is not for this
 * runner. Made-up titles and ids only.
 */
import type { RunnerQueueResponse, RunnerQueueTask } from '@buildd/shared';
import { reduce, type TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const iso = (ms: number) => new Date(ms).toISOString();
/** Thursday 2026-03-12 00:00 local: a plan limit lifting. */
export const THU_MIDNIGHT = new Date(2026, 2, 12, 0, 0, 0).getTime();

const task = (over: Partial<RunnerQueueTask> & { id: string; title: string }): RunnerQueueTask => ({
  workspaceId: 'ws-a', workspaceName: 'alpha', missionId: 'm-k', missionTitle: 'Workflow kernel', roleSlug: 'builder', backend: 'claude',
  priority: 5, createdAt: iso(NOW - 3_600_000), dependsOn: [], holds: [], holdUntil: null, estimateMinutes: null,
  ...over,
});

export const QUEUE: RunnerQueueResponse = {
  truncated: false,
  teams: [
    {
      teamId: 'team-1', teamName: 'Team One', estimatesOn: true,
      queue: [
        task({ id: 'q-review', title: 'fix(kernel): review composition', estimateMinutes: 40 }),
        task({ id: 'q-intake', title: 'feat(intake): one intake door', missionId: 'm-i', missionTitle: 'Bug intake', estimateMinutes: 60 }),
        task({ id: 'q-fonts', title: 'chore(web): cache /fonts', missionId: null, missionTitle: null, estimateMinutes: 15 }),
        task({ id: 'q-docs', title: 'docs: kernel commands', roleSlug: 'writer', dependsOn: ['q-fonts'], holds: ['deps_blocked'] }),
        task({ id: 'q-later', title: 'chore: rotate the logs', holds: ['deferred'], holdUntil: iso(NOW + 2 * 3_600_000) }),
        task({ id: 'q-plan', title: 'Mission: plan the kernel', roleSlug: 'organizer' }),
      ],
      notForRunner: [
        { ...task({ id: 'q-local', title: 'Runner terminal: round 3 audit' }), reason: 'local_session' },
        { ...task({ id: 'q-other', title: 'fix(supersession): close the old PR' }), reason: 'another_runner' },
        { ...task({ id: 'q-design', title: 'design: the queue tab', roleSlug: 'designer' }), reason: 'role_missing' },
      ],
    },
    {
      teamId: 'team-2', teamName: 'Team Two', estimatesOn: false,
      queue: [task({ id: 'q-billing', title: 'fix(billing): round half up', workspaceId: 'ws-b', workspaceName: 'bravo', missionId: null, missionTitle: null })],
      notForRunner: [],
    },
  ],
};

/** The fixture runner with the queue read, the Queue view open, and a plan-limit hold on the first row. */
export function queueState(over: Partial<TopState> = {}): TopState {
  let s = fixtureState();
  s = reduce(s, { type: 'workspaces', workspaces: [
    { id: 'ws-a', name: 'alpha', teamId: 'team-1', teamName: 'Team One' },
    { id: 'ws-b', name: 'bravo', teamId: 'team-2', teamName: 'Team Two' },
  ] });
  s = reduce(s, { type: 'queue', queue: QUEUE });
  s = reduce(s, { type: 'claim_outcome', taskId: 'q-review', outcome: {
    at: NOW - 60_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: iso(THU_MIDNIGHT) }],
  } });
  return { ...s, view: 'queue', ...over };
}
