/**
 * A runner that goes quiet while it updates (Living Spec "Runner updates in
 * minutes", 47c97f48, R-6 and R-7).
 *
 *  - Stuck: its heartbeat is late while draining, or it has not beaten again
 *    15 minutes after the window's end (shared runner-update.ts). Health, Home
 *    and list_runners say "Update stuck on <runner> since <time>" from the
 *    same row. The team is told once, on its own channel, by the notifications
 *    module's tick (api/cron/runner-update-notify), which hands its sender in
 *    as `notify`: core never imports a module. Without a sender (the core
 *    maintenance floor) nothing is stamped as told.
 *  - Released: after 60 minutes of silence each task it paused for the update
 *    starts again as a new attempt from its pushed checkpoint, reason
 *    "runner stopped during an update" (stale-workers.ts
 *    releasePausedWorkersOfStoppedUpdate). Before that its paused tasks stay
 *    with it: the offline-runner reaper leaves them alone (heldForRunnerUpdate).
 *
 * The heartbeat marks the runner due (Redis, `buildd:due:runner-update`) at the
 * moment it would turn stuck if it went quiet then; the gated notify tick wakes
 * Postgres only when one is due, and the hourly maintenance tick is the floor
 * for the release.
 */
import { db } from '@buildd/core/db';
import { accounts, workerHeartbeats } from '@buildd/core/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import {
  nextUpdateCheckAt,
  runnerUpdateLine,
  runnerUpdateState,
  UPDATE_RELEASE_SILENCE_MS,
  type RunnerUpdateView,
} from '@buildd/shared';
import { clearDue, markDue } from '@/lib/redis';
import { withLiveRunnerBeats } from '@/lib/runner-beats';
import { runnerIdentity } from '@/lib/runner-display';

export const RUNNER_UPDATE_DUE_QUEUE = 'runner-update';

const member = (accountId: string, localUiUrl: string) => `${accountId}|${localUiUrl}`;

/** Look at this runner at `dueAtMs` (each beat moves it on). */
export async function markRunnerUpdateDue(accountId: string, localUiUrl: string, dueAtMs: number): Promise<void> {
  await markDue(RUNNER_UPDATE_DUE_QUEUE, member(accountId, localUiUrl), dueAtMs);
}

export interface UpdateRow {
  accountId: string;
  localUiUrl: string;
  lastHeartbeatAt: Date;
  updateDrain: unknown;
  environment?: unknown;
}

export type UpdateWatchAction =
  | { kind: 'notify'; accountId: string; localUiUrl: string; name: string; view: RunnerUpdateView }
  | { kind: 'release'; accountId: string; localUiUrl: string; name: string }
  | { kind: 'due'; accountId: string; localUiUrl: string; at: number }
  | { kind: 'clear'; accountId: string; localUiUrl: string };

/** What the sweep does with each updating runner. Pure: the caller does the I/O. */
export function planUpdateWatch(rows: readonly UpdateRow[], now: number): UpdateWatchAction[] {
  const out: UpdateWatchAction[] = [];
  for (const r of rows) {
    const view = runnerUpdateState({ updateDrain: r.updateDrain, lastHeartbeatAt: r.lastHeartbeatAt }, now);
    const key = { accountId: r.accountId, localUiUrl: r.localUiUrl };
    if (!view) { out.push({ kind: 'clear', ...key }); continue; }
    const name = runnerIdentity({ localUiUrl: r.localUiUrl, environment: r.environment as any }).name;
    const notified = !!(r.updateDrain as { stuckNotifiedAt?: unknown } | null)?.stuckNotifiedAt;
    if (view.stuck && !notified) out.push({ kind: 'notify', ...key, name, view });
    if (view.release) out.push({ kind: 'release', ...key, name });
    const at = nextUpdateCheckAt({ updateDrain: r.updateDrain, lastHeartbeatAt: r.lastHeartbeatAt }, now);
    out.push(at === null ? { kind: 'clear', ...key } : { kind: 'due', ...key, at });
  }
  return out;
}

/** The team's one notification for a stuck update. */
export function stuckUpdateNotice(name: string, view: RunnerUpdateView, appUrl: string) {
  const silentSince = new Date(view.lastHeartbeatAt);
  const releaseAt = new Date(silentSince.getTime() + UPDATE_RELEASE_SILENCE_MS);
  const paused = view.paused.length;
  return {
    title: runnerUpdateLine(view, name, (iso) => `${iso.slice(11, 16)} UTC`).split(' (')[0],
    message:
      `${name} stopped sending heartbeats while ${view.targetVersion ? `updating to ${view.targetVersion}` : 'updating'}. ` +
      (paused > 0
        ? `${paused} agent${paused === 1 ? ' is' : 's are'} paused for the update. If it is not back by ${releaseAt.toISOString().slice(11, 16)} UTC, ` +
          `${paused === 1 ? 'its task starts again as a new attempt from its pushed checkpoint' : 'their tasks start again as new attempts from their pushed checkpoints'}. `
        : '') +
      'Restart the runner on its machine to continue now.',
    url: `${appUrl}/app/health`,
    urlTitle: 'Open Health',
    priority: 0 as const,
  };
}

export interface UpdateWatchDeps {
  loadRows(): Promise<UpdateRow[]>;
  /** Stamp the one notification; true when this call stamped it (nobody did before). */
  claimNotify(accountId: string, localUiUrl: string, now: Date): Promise<boolean>;
  /** Sends the notice to the account's team. Absent: no notification is sent or stamped. */
  notify?: (accountId: string, notice: ReturnType<typeof stuckUpdateNotice>) => Promise<void>;
  release(accountId: string, localUiUrl: string, now: Date): Promise<number>;
  markDue(accountId: string, localUiUrl: string, at: number): Promise<void>;
  clearDue(accountId: string, localUiUrl: string): Promise<void>;
}

export async function runUpdateWatch(deps: UpdateWatchDeps, now: Date = new Date(), appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev') {
  const rows = await deps.loadRows();
  const counts = { runners: rows.length, notified: 0, released: 0 };
  for (const a of planUpdateWatch(rows, now.getTime())) {
    try {
      if (a.kind === 'notify') {
        if (deps.notify && await deps.claimNotify(a.accountId, a.localUiUrl, now)) {
          await deps.notify(a.accountId, stuckUpdateNotice(a.name, a.view, appUrl));
          counts.notified++;
        }
      } else if (a.kind === 'release') {
        counts.released += await deps.release(a.accountId, a.localUiUrl, now);
      } else if (a.kind === 'due') {
        await deps.markDue(a.accountId, a.localUiUrl, a.at);
      } else {
        await deps.clearDue(a.accountId, a.localUiUrl);
      }
    } catch (err) {
      console.error(`[runner-update-watch] ${a.kind} failed for ${a.localUiUrl}:`, err instanceof Error ? err.message : err);
    }
  }
  return counts;
}

/** The team an account belongs to, for the notifications module's sender. */
export async function accountTeamId(accountId: string): Promise<string | null> {
  const account = await db.query.accounts.findFirst({ where: sqlWhere(eq(accounts.id, accountId)), columns: { teamId: true } });
  return account?.teamId ?? null;
}

/** The real dependencies; `notify` only from the notifications module. */
export function createUpdateWatchDeps(opts: { notify?: UpdateWatchDeps['notify'] } = {}): UpdateWatchDeps {
  return {
    notify: opts.notify,
    loadRows: async () => {
      const rows = await db.query.workerHeartbeats.findMany({
        where: sqlWhere(isNotNull(workerHeartbeats.updateDrain)),
        columns: { accountId: true, localUiUrl: true, lastHeartbeatAt: true, updateDrain: true, environment: true },
      });
      const live = await withLiveRunnerBeats(rows);
      return live.map(r => ({ ...r, lastHeartbeatAt: r.lastHeartbeatAt instanceof Date ? r.lastHeartbeatAt : new Date(r.lastHeartbeatAt as string) }));
    },
    claimNotify: async (accountId, localUiUrl, now) => {
      const stamped = await db
        .update(workerHeartbeats)
        .set({ updateDrain: sql`jsonb_set(${workerHeartbeats.updateDrain}, '{stuckNotifiedAt}', to_jsonb(${now.toISOString()}::text))` as any })
        .where(and(
          eq(workerHeartbeats.accountId, accountId),
          eq(workerHeartbeats.localUiUrl, localUiUrl),
          isNotNull(workerHeartbeats.updateDrain),
          sql`(${workerHeartbeats.updateDrain} ->> 'stuckNotifiedAt') IS NULL`,
        ))
        .returning({ id: workerHeartbeats.id });
      return stamped.length > 0;
    },
    release: async (accountId, localUiUrl, now) => {
      const { releasePausedWorkersOfStoppedUpdate } = await import('@/lib/stale-workers');
      return releasePausedWorkersOfStoppedUpdate(accountId, localUiUrl, now);
    },
    markDue: (accountId, localUiUrl, at) => markDue(RUNNER_UPDATE_DUE_QUEUE, member(accountId, localUiUrl), at),
    clearDue: (accountId, localUiUrl) => clearDue(RUNNER_UPDATE_DUE_QUEUE, member(accountId, localUiUrl)),
  };
}
