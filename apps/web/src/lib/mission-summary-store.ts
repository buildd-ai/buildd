/**
 * The stored mission summary's writer and reconcile (spec 3ef37387 R-13,
 * AC-2). `computeMissionSummary` (lib/mission-summary.ts) is what is stored;
 * this is when, and how it stays right.
 *
 * Writer. Core notes every write of work (lib/work-changed.ts): a task's
 * status or mission, a worker's status or PR, a kernel command, every core
 * event's ids. Those notes are coalesced per request and handed, after the
 * response, to `refreshMissionSummariesFor` (the composition root's listener),
 * which resolves them to missions, reads each mission's rows in one batched
 * load, computes, and upserts each summary in one statement fenced on
 * `computed_at`: a row is only replaced by one computed from later reads, so
 * two refreshes that race never leave the older answer. No transaction
 * (neon-http). `refreshMissionSummary(missionId)` notes one mission the same way.
 *
 * Reconcile. A write path that forgets to note leaves a summary stale, and a
 * note is at most once. `reconcileMissionSummaries` recomputes a bounded
 * sample, missing and oldest first, writes it, and counts what differed: how
 * many were missing, how many differed, and how many differed even computed
 * at their own `computed_at` (a write that never refreshed, as opposed to a
 * reading that aged). It is also the backfill: every mission starts missing.
 */
import { db } from '@buildd/core/db';
import { missionSummaries, missions, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { MISSION_SUMMARY_VERSION, type MissionSummary } from '@buildd/shared';
import { computeMissionSummary, summariesEqual, type MissionSummaryInput } from './mission-summary';
import { trackEvent } from './axiom';
import { bumpChangeVersions, teamChangeScope } from './change-version';
import { noteWorkChanged, type WorkChange, type WorkChangeBatch } from './work-changed';

export interface StoredMissionSummary {
  missionId: string;
  workspaceId: string | null;
  version: number;
  summary: MissionSummary;
  computedAt: Date;
}

export interface MissionSummaryStoreDeps {
  load: (missionIds: string[]) => Promise<Map<string, MissionSummaryInput>>;
  /** Mission ids of the named tasks, workers and PRs. */
  resolve: (t: { taskIds: string[]; workerIds: string[]; prUrls: string[]; workspacePrs: Array<{ workspaceId: string; prNumber: number }> }) => Promise<string[]>;
  /** Upsert, fenced on `computed_at`; returns the mission ids written. */
  write: (rows: StoredMissionSummary[]) => Promise<string[]>;
  readStored: (missionIds: string[]) => Promise<Map<string, StoredMissionSummary>>;
  /** Up to `limit` mission ids, missing or other-version first, then oldest `computed_at`. */
  sample: (limit: number) => Promise<string[]>;
  now: () => number;
  /** The reconcile's counts, as a span (R-29: names and counts, never values). */
  record: (event: string, fields: Record<string, number>) => void;
  /** Lists that read these workspaces' and teams' summaries change version (R-20, lib/change-version.ts). */
  changed?: (scopes: string[]) => Promise<void>;
}

/** Missions per batched load: a burst of writes is loaded in chunks this size. */
export const SUMMARY_FLUSH_CHUNK = 25;
/** Most missions one reconcile pass recomputes (R-25: a bounded batch). */
export const RECONCILE_MAX_LIMIT = 200;
export const RECONCILE_DEFAULT_LIMIT = 50;

const prUrlOf = (repoFullName: string, prNumber: number) => `https://github.com/${repoFullName}/pull/${prNumber}`;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>;
}

export const defaultMissionSummaryStoreDeps: MissionSummaryStoreDeps = {
  load: async (ids) => (await import('./mission-summary-load')).loadMissionSummaryInputs(ids),
  resolve: async ({ taskIds, workerIds, prUrls, workspacePrs }) => {
    const reads: Array<Promise<Array<{ missionId: string | null }>>> = [];
    if (taskIds.length > 0) {
      reads.push(db.select({ missionId: tasks.missionId }).from(tasks).where(inArray(tasks.id, taskIds)));
    }
    const byWorker: SQL[] = [];
    if (workerIds.length > 0) byWorker.push(inArray(workers.id, workerIds));
    if (prUrls.length > 0) byWorker.push(inArray(workers.prUrl, prUrls));
    for (const pr of workspacePrs) byWorker.push(and(eq(workers.workspaceId, pr.workspaceId), eq(workers.prNumber, pr.prNumber))!);
    if (byWorker.length > 0) {
      reads.push(db.select({ missionId: tasks.missionId }).from(workers)
        .innerJoin(tasks, eq(workers.taskId, tasks.id))
        .where(or(...byWorker)));
    }
    const found = (await Promise.all(reads)).flat();
    return [...new Set(found.map(r => r.missionId).filter((m): m is string => !!m))];
  },
  write: async (rows) => {
    if (rows.length === 0) return [];
    const upsert = (batch: StoredMissionSummary[]) => db.insert(missionSummaries)
      .values(batch.map(r => ({ ...r, lastActivityAt: r.summary.lastActivityAt ? new Date(r.summary.lastActivityAt) : null })))
      .onConflictDoUpdate({
        target: missionSummaries.missionId,
        set: {
          workspaceId: sql`excluded.workspace_id`,
          version: sql`excluded.version`,
          summary: sql`excluded.summary`,
          lastActivityAt: sql`excluded.last_activity_at`,
          computedAt: sql`excluded.computed_at`,
        },
        // The fence: never replace a summary computed from later reads.
        setWhere: sql`${missionSummaries.computedAt} <= excluded.computed_at`,
      })
      .returning({ missionId: missionSummaries.missionId });
    try {
      return (await upsert(rows)).map(r => r.missionId);
    } catch {
      // One mission deleted between the read and the write fails the batch on its key: write the rest alone.
      const written: string[] = [];
      for (const r of rows) {
        try { written.push(...(await upsert([r])).map(x => x.missionId)); } catch { /* gone; nothing to store */ }
      }
      return written;
    }
  },
  readStored: async (ids) => {
    const out = new Map<string, StoredMissionSummary>();
    if (ids.length === 0) return out;
    const rows = await db.select({
      missionId: missionSummaries.missionId, workspaceId: missionSummaries.workspaceId, version: missionSummaries.version,
      summary: missionSummaries.summary, computedAt: missionSummaries.computedAt,
    }).from(missionSummaries).where(inArray(missionSummaries.missionId, ids));
    for (const r of rows) out.set(r.missionId, r as StoredMissionSummary);
    return out;
  },
  sample: async (limit) => {
    const res = await db.execute(sql`-- mission-summary:reconcile-sample
      select ${missions.id} as id from ${missions}
      left join ${missionSummaries} on ${missionSummaries.missionId} = ${missions.id}
      order by case when ${missionSummaries.version} = ${MISSION_SUMMARY_VERSION} then ${missionSummaries.computedAt} end asc nulls first,
        ${missions.id}
      limit ${limit}`);
    return rowsOf(res).map(r => String(r.id));
  },
  now: () => Date.now(),
  record: (event, fields) => trackEvent(event, fields),
  changed: (scopes) => bumpChangeVersions(scopes),
};

/**
 * A summary store. The module's own (below) uses the real database; a test
 * builds one over its fixtures.
 */
export function createMissionSummaryStore(deps: MissionSummaryStoreDeps) {
  /** Bump the change version of the workspaces and teams whose summaries were written. */
  async function noteWritten(written: string[], inputs: Map<string, MissionSummaryInput>): Promise<void> {
    if (!deps.changed || written.length === 0) return;
    const scopes: string[] = [];
    for (const id of written) {
      const m = inputs.get(id)?.missionRows[0] as { workspaceId?: string | null; teamId?: string | null } | undefined;
      if (m?.workspaceId) scopes.push(m.workspaceId);
      if (m?.teamId) scopes.push(teamChangeScope(m.teamId));
    }
    try { await deps.changed(scopes); } catch (err) { console.error('[mission-summary] change version bump failed:', err); }
  }

  /** Load, compute and write these missions' summaries now. Returns what was written. */
  async function recompute(missionIds: string[]): Promise<{ computed: Map<string, StoredMissionSummary>; written: string[] }> {
    const computed = new Map<string, StoredMissionSummary>();
    const written: string[] = [];
    for (const ids of chunks([...new Set(missionIds)], SUMMARY_FLUSH_CHUNK)) {
      // The fence's time is taken BEFORE the read: a row from later reads always wins.
      const readAt = deps.now();
      const inputs = await deps.load(ids);
      const rows: StoredMissionSummary[] = [];
      for (const [id, input] of inputs) {
        const mission = input.missionRows[0] as { workspaceId?: string | null } | undefined;
        try {
          rows.push({
            missionId: id, workspaceId: mission?.workspaceId ?? null, version: MISSION_SUMMARY_VERSION,
            summary: computeMissionSummary(input, readAt), computedAt: new Date(readAt),
          });
        } catch (err) {
          console.error(`[mission-summary] compute failed for ${id}:`, err);
        }
      }
      for (const r of rows) computed.set(r.missionId, r);
      const wrote = await deps.write(rows);
      written.push(...wrote);
      await noteWritten(wrote, inputs);
    }
    return { computed, written };
  }

  /** Resolve a batch of changed rows to their missions and recompute those. */
  async function refreshFor(batch: WorkChangeBatch): Promise<string[]> {
    const ids = new Set(batch.missionIds);
    const prUrls = batch.prs.map(pr => prUrlOf(pr.repoFullName, pr.prNumber));
    if (batch.taskIds.length + batch.workerIds.length + prUrls.length + batch.workspacePrs.length > 0) {
      for (const id of await deps.resolve({ taskIds: batch.taskIds, workerIds: batch.workerIds, prUrls, workspacePrs: batch.workspacePrs })) ids.add(id);
    }
    if (ids.size === 0) return [];
    return (await recompute([...ids])).written;
  }

  /** Recompute a bounded sample, missing and oldest first; write and count what differs. */
  async function reconcile(opts: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(RECONCILE_MAX_LIMIT, Math.floor(opts.limit ?? RECONCILE_DEFAULT_LIMIT)));
    const ids = await deps.sample(limit);
    const stored = await deps.readStored(ids);
    const counts = { checked: 0, missing: 0, otherVersion: 0, unchanged: 0, repaired: 0, missedWrites: 0, written: 0 };

    // One read serves both comparisons: the fresh summary, and the summary
    // these same rows give at the stored row's own computed_at (differing
    // there means rows changed and nothing refreshed it).
    const readAt = deps.now();
    const inputs = await deps.load(ids);
    const fresh: StoredMissionSummary[] = [];
    /** Only a summary that changed moves a list's change version; an unchanged rewrite does not. */
    const differ = new Set<string>();
    for (const id of ids) {
      const input = inputs.get(id);
      if (!input) continue;
      counts.checked++;
      let summary: MissionSummary;
      try {
        summary = computeMissionSummary(input, readAt);
      } catch (err) {
        console.error(`[mission-summary] reconcile compute failed for ${id}:`, err);
        continue;
      }
      const prev = stored.get(id);
      if (!prev) { counts.missing++; differ.add(id); }
      else if (prev.version !== MISSION_SUMMARY_VERSION) { counts.otherVersion++; differ.add(id); }
      else if (summariesEqual(prev.summary, summary)) { counts.unchanged++; }
      else {
        counts.repaired++;
        differ.add(id);
        try {
          if (!summariesEqual(prev.summary, computeMissionSummary(input, new Date(prev.computedAt).getTime()))) counts.missedWrites++;
        } catch { /* counted as repaired only */ }
      }
      // Unchanged rows are rewritten too: their computed_at moves, so the sample moves on.
      const mission = input.missionRows[0] as { workspaceId?: string | null } | undefined;
      fresh.push({ missionId: id, workspaceId: mission?.workspaceId ?? null, version: MISSION_SUMMARY_VERSION, summary, computedAt: new Date(readAt) });
    }
    const wrote = await deps.write(fresh);
    counts.written = wrote.length;
    await noteWritten(wrote.filter(id => differ.has(id)), inputs);
    deps.record('mission_summary.reconcile', { limit, ...counts });
    return counts;
  }

  return { refreshFor, recompute, reconcile };
}

export type MissionSummaryStore = ReturnType<typeof createMissionSummaryStore>;

let store: MissionSummaryStore = createMissionSummaryStore(defaultMissionSummaryStoreDeps);

/** Tests: swap the module's store (and get the previous one back to restore). */
export function setMissionSummaryStoreForTests(next: MissionSummaryStore): MissionSummaryStore {
  const prev = store;
  store = next;
  return prev;
}

/** Refresh these missions' summaries after the response (coalesced with every other note in the request). Never throws. */
export function refreshMissionSummary(...missionIds: Array<string | null | undefined>): void {
  noteWorkChanged({ missionIds });
}

/** Any mix of mission, task, worker and PR ids, resolved to their missions in the flush. */
export function refreshMissionSummaries(change: WorkChange): void {
  noteWorkChanged(change);
}

/** The composition root's work-change listener (apps/web/src/modules.ts): refresh what a batch touched, now. */
export function refreshMissionSummariesFor(batch: WorkChangeBatch): Promise<string[]> {
  return store.refreshFor(batch);
}

export function recomputeMissionSummaries(missionIds: string[]) {
  return store.recompute(missionIds);
}

export function reconcileMissionSummaries(opts?: { limit?: number }) {
  return store.reconcile(opts);
}

/** Stored summaries of the current version, by mission id, scoped to these workspaces. */
export async function readMissionSummaries(missionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, StoredMissionSummary>> {
  const out = new Map<string, StoredMissionSummary>();
  if (missionIds.length === 0 || workspaceIds.length === 0) return out;
  const rows = await db.select({
    missionId: missionSummaries.missionId, workspaceId: missionSummaries.workspaceId, version: missionSummaries.version,
    summary: missionSummaries.summary, computedAt: missionSummaries.computedAt,
  })
    .from(missionSummaries)
    .innerJoin(missions, sql`${missions.id} = ${missionSummaries.missionId}`)
    .where(and(
      inArray(missionSummaries.missionId, [...missionIds]),
      // The mission's own workspace, never the copy on the summary row: a moved mission reads where it is now.
      inArray(missions.workspaceId, [...workspaceIds]),
      sql`${missionSummaries.version} = ${MISSION_SUMMARY_VERSION}`,
    ));
  for (const r of rows) out.set(r.missionId, r as StoredMissionSummary);
  return out;
}
