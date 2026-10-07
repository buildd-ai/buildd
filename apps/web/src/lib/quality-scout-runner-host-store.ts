/**
 * The SQL behind `ScoutRunnerHostStore` (quality-scout-runner-host.ts). Every
 * statement that decides who may act carries the decision in its own WHERE:
 * team scoping is a join/subquery on `workspaces.team_id`, the lease is a
 * compare-and-set on `host_lease_holder` / `host_lease_expires_at`, and a
 * probe result is written only while the writer's lease is live (one
 * statement, so a lease lost between check and write writes nothing). No
 * `db.transaction` (neon-http). Pinned against real Postgres in
 * apps/web/tests/db/quality-scout-runner-host.test.ts.
 */
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubRepos, qualityScoutProbes, qualityScoutRuns, workspaces } from '@buildd/core/db/schema';
import { scoutProbeFromRow, scoutRunFromRow } from '@buildd/core/quality-scout/ledger';
import type { ScoutMode, ScoutProbeRecord } from '@buildd/core/quality-scout/types';
import { finalizeScoutRun } from '@/lib/quality-scout-run';
import type { ClaimableScoutRun, ScoutRunnerHostStore } from '@/lib/quality-scout-runner-host';
import {
  finalizeExpiredQualityScoutRuns,
  loadScoutWorkspace,
  resolveScoutTriggerConfig,
  serverScoutFinalizeDeps,
} from '@/lib/quality-scout-trigger';

const MAX_RUN_WARNINGS = 20;

const runs = qualityScoutRuns;
const probes = qualityScoutProbes;

/** Never claimed, released, or lapsed exactly once (a second lapse is the sweep's). */
const leaseFree = (now: Date) => or(
  isNull(runs.hostLeaseExpiresAt),
  and(lte(runs.hostLeaseExpiresAt, now), eq(runs.hostLeaseLapses, 0)),
);

const teamWorkspaces = (teamId: string) => db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, teamId));

const pendingRunnerProbe = and(
  eq(probes.host, 'runner'),
  isNull(probes.result),
  sql`${probes.selection} ->> 'status' = 'selected'`,
);

export const dbScoutRunnerHostStore: ScoutRunnerHostStore = {
  async sweepExpired({ teamId, workspaceIds }) {
    const sweep = await finalizeExpiredQualityScoutRuns({ teamId, workspaceIds });
    return sweep.finalized;
  },

  async listClaimable({ teamId, workspaceIds, now, limit }) {
    if (workspaceIds.length === 0) return [];
    const rows = await db.select({ run: runs, repo: githubRepos.fullName })
      .from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
      .where(and(
        eq(runs.status, 'awaiting_host'),
        eq(workspaces.teamId, teamId),
        inArray(runs.workspaceId, [...workspaceIds]),
        gt(runs.hostDeadline, now),
        leaseFree(now),
      ))
      .orderBy(asc(runs.hostDeadline))
      .limit(limit);
    if (rows.length === 0) return [];
    const probeRows = await db.select().from(probes)
      .where(and(inArray(probes.runId, rows.map((r) => r.run.id)), pendingRunnerProbe));
    const byRun = new Map<string, ScoutProbeRecord[]>();
    for (const p of probeRows) {
      const list = byRun.get(p.runId) ?? [];
      list.push(scoutProbeFromRow(p));
      byRun.set(p.runId, list);
    }
    return rows.map((r): ClaimableScoutRun => ({
      run: scoutRunFromRow(r.run),
      repo: r.repo ?? null,
      probes: byRun.get(r.run.id) ?? [],
    }));
  },

  async claim({ runId, teamId, holder, now, leaseExpiresAt }) {
    const rows = await db.update(runs)
      .set({
        hostLeaseHolder: holder,
        hostLeaseExpiresAt: leaseExpiresAt,
        // Taking over a lapsed lease counts the lapse; a released or never-held lease does not.
        hostLeaseLapses: sql`CASE WHEN ${runs.hostLeaseExpiresAt} IS NULL THEN ${runs.hostLeaseLapses} ELSE ${runs.hostLeaseLapses} + 1 END`,
      })
      .where(and(
        eq(runs.id, runId),
        eq(runs.status, 'awaiting_host'),
        inArray(runs.workspaceId, teamWorkspaces(teamId)),
        gt(runs.hostDeadline, now),
        leaseFree(now),
      ))
      .returning();
    return rows[0] ? scoutRunFromRow(rows[0]) : null;
  },

  async loadForTeam(runId, teamId) {
    const [row] = await db.select({ run: runs })
      .from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .where(and(eq(runs.id, runId), eq(workspaces.teamId, teamId)))
      .limit(1);
    if (!row) return null;
    const probeRows = await db.select().from(probes).where(eq(probes.runId, runId));
    return { run: scoutRunFromRow(row.run), probes: probeRows.map(scoutProbeFromRow) };
  },

  async recordResult({ runId, holder, now, candidateId, result, reproducibility }) {
    const written = await db.update(probes)
      .set({ result, verdict: result.verdict, signature: result.signature, updatedAt: now })
      .where(and(
        eq(probes.runId, runId),
        eq(probes.candidateId, candidateId),
        pendingRunnerProbe,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${runId}::uuid
            AND ${runs.status} = 'awaiting_host'
            AND ${runs.hostLeaseHolder} = ${holder}
            AND ${runs.hostLeaseExpiresAt} > ${now.toISOString()}::timestamptz
        )`,
      ))
      .returning({ id: probes.id });
    if (written.length === 0) return false;
    // Finalize reads reproducibility from the frozen plan; keep it there.
    await db.update(runs)
      .set({
        hostState: sql`jsonb_set(${runs.hostState}, '{plan,reproducibility}',
          coalesce(${runs.hostState} -> 'plan' -> 'reproducibility', '{}'::jsonb) || jsonb_build_object(${candidateId}::text, ${reproducibility}::text))`,
      })
      .where(and(eq(runs.id, runId), eq(runs.hostLeaseHolder, holder), sql`${runs.hostState} IS NOT NULL`));
    return true;
  },

  async remainingRunnerProbes(runId) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(probes)
      .where(and(eq(probes.runId, runId), pendingRunnerProbe));
    return Number(row?.n ?? 0);
  },

  async take(runId, holder) {
    // `running` is the lock, exactly as in the expiry sweep: if finalize dies
    // after this, a re-trigger takes the stale row over and re-plans.
    const rows = await db.update(runs).set({ status: 'running' })
      .where(and(eq(runs.id, runId), eq(runs.status, 'awaiting_host'), eq(runs.hostLeaseHolder, holder)))
      .returning({ id: runs.id });
    return rows.length > 0;
  },

  async finalize(run, records) {
    const ws = await loadScoutWorkspace(run.workspaceId);
    const policy = resolveScoutTriggerConfig(ws?.gitConfig?.qualityScout).policy;
    return finalizeScoutRun(
      {
        run,
        records,
        summary: structuredClone(run.parking!.plan),
        mode: run.mode as Exclude<ScoutMode, 'off'>,
        policy,
      },
      serverScoutFinalizeDeps(ws, run),
    );
  },

  async release({ runId, holder, now, reason }) {
    const note = `runner released: ${reason}`;
    const rows = await db.update(runs)
      .set({
        hostLeaseHolder: null,
        hostLeaseExpiresAt: null,
        hostState: sql`CASE
          WHEN jsonb_array_length(coalesce(${runs.hostState} -> 'plan' -> 'warnings', '[]'::jsonb)) < ${MAX_RUN_WARNINGS}
          THEN jsonb_set(${runs.hostState}, '{plan,warnings}', coalesce(${runs.hostState} -> 'plan' -> 'warnings', '[]'::jsonb) || to_jsonb(${note}::text))
          ELSE ${runs.hostState} END`,
      })
      .where(and(
        eq(runs.id, runId),
        eq(runs.status, 'awaiting_host'),
        eq(runs.hostLeaseHolder, holder),
        gt(runs.hostLeaseExpiresAt, now),
      ))
      .returning({ id: runs.id });
    return rows.length > 0;
  },
};
