/**
 * Branch retirement's wiring (lib/branch-retire.ts decides, lib/branch-retire-store.ts acts).
 *
 * - `pr.close_delivered`: every PR close, merged or not, worker-owned or not (a
 *   release candidate has no worker). Its head goes if nothing still needs it.
 * - `task.terminal`: the branches the task's workers pushed, PR or not.
 * - `sweep.pr_hourly`: once a day (SWEEP_HOUR_UTC), every buildd-made branch of
 *   every linked repo. The floor for a lost webhook, a PR-less branch that had to
 *   age, and a mission that ended after its last PR.
 *
 * GitHub-heavy, so the event paths run after the response; all are idempotent
 * (a branch already gone is "gone").
 */
import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';

/** The sweep runs on the hourly tick that falls in this UTC hour. */
export const SWEEP_HOUR_UTC = 4;

function later(label: string, run: () => Promise<unknown>): void {
  const go = () => run().then(() => undefined, (err) => console.warn(`[branch-retire] ${label} failed (non-fatal):`, err instanceof Error ? err.message : err));
  try {
    after(go);
  } catch {
    // after() is unavailable outside a request scope (tests, cron): run inline, unawaited.
    void go();
  }
}

export const branchRetireSubscribers: readonly AnySubscriber[] = [
  subscriber('reviews', 'pr.close_delivered', 'branch-retire-on-close', (e) => {
    if (e.installationId == null || !e.headRef) return;
    later(`${e.repoFullName}#${e.prNumber}`, async () => {
      const { retireClosedPrBranch } = await import('@/lib/branch-retire-store');
      const r = await retireClosedPrBranch(e);
      if (r) console.log(`[branch-retire] ${e.repoFullName}#${e.prNumber} ${e.headRef}: ${r.action} (${r.reason})`);
    });
  }),
  subscriber('reviews', 'task.terminal', 'branch-retire-on-task-end', (e) => {
    later(`task ${e.taskId.slice(0, 8)}`, async () => {
      const { retireTaskBranches } = await import('@/lib/branch-retire-store');
      const out = await retireTaskBranches(e.taskId);
      for (const r of out) if (r.deleted) console.log(`[branch-retire] task ${e.taskId.slice(0, 8)}: deleted (${r.reason})`);
    });
  }),
  subscriber('reviews', 'sweep.pr_hourly', 'branch-retire-sweep', async (e) => {
    if (e.at.getUTCHours() !== SWEEP_HOUR_UTC) return;
    const { sweepDeadBranches } = await import('@/lib/branch-retire-store');
    const r = await sweepDeadBranches();
    console.log(`[branch-retire] sweep repos=${r.repos} listed=${r.listed} evaluated=${r.evaluated} deleted=${r.deleted} truncated=${r.truncated} kept=${JSON.stringify(r.kept)}`);
  }),
];
