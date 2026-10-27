/**
 * Loads a mission's builder claims (./builder-claims.ts) from what is already
 * recorded: each build task's status, summary, handoff and recorded
 * mismatches (tasks.result), its newest worker's PR, the artifacts its
 * workers saved, and a cancellation's supersededBy. Bookkeeping (checks,
 * verifications) is not a builder. Best-effort: a read error reads as no claims.
 */
import { db } from '@buildd/core/db';
import { artifacts, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import type { TaskMismatch, TaskResult } from '@buildd/shared';
import { readCancellation } from '@/lib/task-cancellation';
import type { BuilderClaim } from './builder-claims';

const MAX_TASKS = 60;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : typeof v === 'string' && v.trim() ? [v] : []);
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export async function loadBuilderClaims(missionId: string): Promise<BuilderClaim[]> {
  try {
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(and(eq(tasks.missionId, missionId), ne(tasks.taskClass, 'bookkeeping'))),
      columns: { id: true, title: true, status: true, result: true, context: true },
      with: {
        workers: {
          columns: { id: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
          orderBy: sqlOrderByFn((w, { desc }) => [desc(w.startedAt)]),
        },
      },
      orderBy: sqlOrderByFn((t, { asc }) => [asc(t.createdAt)]),
      limit: MAX_TASKS,
    });
    const workerIds = rows.flatMap((r) => (r.workers as Array<{ id: string }>).map((w) => w.id));
    const saved = workerIds.length
      ? await db.select({ id: artifacts.id, workerId: artifacts.workerId, type: artifacts.type, title: artifacts.title }).from(artifacts)
          .where(and(inArray(artifacts.workerId, workerIds), ne(artifacts.type, 'screenshot'))).limit(300)
      : [];
    return rows.map((r) => {
      const ws = r.workers as Array<{ id: string; prNumber: number | null; mergedAt: Date | null; prLifecycleStatus: string | null }>;
      const result = (r.result ?? {}) as TaskResult;
      const out = asRecord(result.structuredOutput);
      const handoff = asRecord(out?.handoff);
      const withPr = ws.find((w) => w.prNumber != null);
      const ids = new Set(ws.map((w) => w.id));
      const superseded = readCancellation(r.context)?.supersededBy;
      return {
        taskId: r.id,
        title: r.title ?? '(untitled)',
        status: r.status,
        supersededBy: superseded && 'taskId' in superseded ? superseded.taskId : superseded && 'prNumber' in superseded ? `PR #${superseded.prNumber}` : null,
        summary: result.summary ?? null,
        summarySource: result.summarySource ?? null,
        delivered: typeof handoff?.delivered === 'string' ? handoff.delivered : null,
        decisions: Array.isArray(handoff?.decisions)
          ? (handoff.decisions as unknown[]).flatMap((d) => { const x = asRecord(d); return typeof x?.decision === 'string' ? [`${x.decision}${typeof x.why === 'string' ? ` (${x.why})` : ''}`] : []; })
          : [],
        leftUndone: strings(handoff?.leftUndone),
        assumptions: [...strings(out?.assumptions), ...strings(out?.assessment)],
        mismatches: (Array.isArray(result.mismatch) ? result.mismatch : []) as TaskMismatch[],
        pr: withPr ? { number: withPr.prNumber!, merged: !!withPr.mergedAt || withPr.prLifecycleStatus === 'merged', closedUnmerged: !withPr.mergedAt && withPr.prLifecycleStatus === 'closed' } : null,
        reports: saved.filter((a) => a.workerId && ids.has(a.workerId)).map((a) => ({ id: a.id, type: a.type, title: a.title })),
      };
    });
  } catch (err) {
    console.error(`[final-verification] builder claims for mission ${missionId} could not be read:`, err instanceof Error ? err.message : err);
    return [];
  }
}
