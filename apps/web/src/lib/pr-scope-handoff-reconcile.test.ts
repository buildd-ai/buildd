import { describe, expect, it, mock } from 'bun:test';
import { scheduleHandoffScopeReconcile } from './pr-scope-handoff-reconcile';

const linked = async () => ({ fullName: 'org/repo', installationId: 42 });

describe('scheduleHandoffScopeReconcile', () => {
  // A worker's PR handoff widens the manifest to everything it leased, and the
  // only thing that narrowed it back was the next push. A PR with no later
  // push kept the inherited scope on layer 1 for as long as it stayed open.
  it('schedules one pinned reconciliation of the handed-off PR', async () => {
    const schedule = mock(() => {});
    await scheduleHandoffScopeReconcile({ workspaceId: 'ws-1', prNumber: 7 }, { resolveRepo: linked, schedule });
    expect(schedule).toHaveBeenCalledWith({ workspaceId: 'ws-1', installationId: 42, repoFullName: 'org/repo', prNumber: 7 });
  });

  it('does nothing without a PR number or a linked repo', async () => {
    const schedule = mock(() => {});
    await scheduleHandoffScopeReconcile({ workspaceId: 'ws-1', prNumber: null }, { resolveRepo: linked, schedule });
    await scheduleHandoffScopeReconcile({ workspaceId: 'ws-1', prNumber: 7 }, { resolveRepo: async () => null, schedule });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('never throws: a failed lookup leaves the wider, conservative scope', async () => {
    const schedule = mock(() => {});
    await expect(scheduleHandoffScopeReconcile(
      { workspaceId: 'ws-1', prNumber: 7 },
      { resolveRepo: async () => { throw new Error('db'); }, schedule },
    )).resolves.toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });
});
