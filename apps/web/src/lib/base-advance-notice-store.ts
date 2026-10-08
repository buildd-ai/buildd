/**
 * DB half of base-advance notices (see `base-advance-notice.ts`): who is live,
 * the instruct-queue write, and the gate-ledger record that doubles as the
 * debounce state.
 */
import { db } from '@buildd/core/db';
import { gateEvents, workers, workspaces } from '@buildd/core/db/schema';
import { recordGateEvent, GATE_SLUGS } from '@buildd/core/gate-events';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { and, desc, eq, gt, inArray, isNull, not, sql } from 'drizzle-orm';
import { workspaceRepoMatches } from '@/lib/repo-scope';
import { githubApi } from '@/lib/github';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import {
  notifyBaseAdvance,
  type BaseAdvanceCandidate,
  type BaseAdvanceChange,
  type BaseAdvanceDeps,
  type BaseAdvanceInput,
  type BaseAdvanceResult,
  type BaseResolver,
} from '@/lib/base-advance-notice';

export const BASE_ADVANCE_SURFACE = 'POST /api/github/webhook';
const NOTICE_REASON = 'base branch advanced under a live worker on overlapping files';
/** A worker silent this long is not going to read a queued instruction. */
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createBaseAdvanceStore(resolver: BaseResolver): BaseAdvanceDeps {
  const sensitive = new Map<string, boolean>();

  return {
    resolver,

    async loadCandidates(repoFullName) {
      const ws = await db
        .select({ id: workspaces.id, gitConfig: workspaces.gitConfig, dataClass: workspaces.dataClass })
        .from(workspaces)
        .where(workspaceRepoMatches(repoFullName));
      if (ws.length === 0) return [];
      const byId = new Map(ws.map(w => [w.id, w]));

      const rows = await db.query.workers.findMany({
        where: and(
          inArray(workers.workspaceId, ws.map(w => w.id)),
          not(inArray(workers.status, [...TERMINAL_WORKER_STATUSES])),
          isNull(workers.mergedAt),
          gt(workers.updatedAt, new Date(Date.now() - LIVE_WINDOW_MS)),
        ),
        columns: {
          id: true, taskId: true, workspaceId: true, branch: true,
          prNumber: true, prBaseRef: true, observedTouches: true,
        },
        with: {
          task: {
            columns: { title: true, taskClass: true, context: true, pathManifest: true, missionId: true },
            with: { mission: { columns: { workingBranch: true, integrationBranchEnabled: true } } },
          },
        },
      });

      return rows.map((r): BaseAdvanceCandidate => {
        const w = byId.get(r.workspaceId);
        sensitive.set(r.id, w?.dataClass === 'sensitive');
        const task = r.task as (typeof r.task & { mission?: BaseAdvanceCandidate['mission'] }) | null;
        return {
          workerId: r.id,
          taskId: r.taskId,
          workspaceId: r.workspaceId,
          missionId: task?.missionId ?? null,
          branch: r.branch,
          prNumber: r.prNumber,
          prBaseRef: r.prBaseRef,
          observedTouches: Array.isArray(r.observedTouches) ? r.observedTouches : null,
          pathManifest: Array.isArray(task?.pathManifest) ? task!.pathManifest : null,
          task: task ? { title: task.title, taskClass: task.taskClass, context: task.context } : null,
          mission: task?.mission ?? null,
          gitConfig: w?.gitConfig ?? null,
        };
      });
    },

    async findRecentNotice(workerId, baseRef, since) {
      const [row] = await db
        .select({ id: gateEvents.id })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.gate, GATE_SLUGS.BASE_ADVANCE_NOTICE),
          eq(gateEvents.workerId, workerId),
          gt(gateEvents.occurredAt, since),
          sql`${gateEvents.detail} @> ${JSON.stringify({ baseRef })}::jsonb`,
        ))
        .orderBy(desc(gateEvents.occurredAt))
        .limit(1);
      return row?.id ?? null;
    },

    async coalesceNotice(noticeId, change: BaseAdvanceChange, files) {
      // One statement: count + the PRs/files that landed inside the window.
      await db
        .update(gateEvents)
        .set({
          detail: sql`jsonb_set(
            jsonb_set(
              COALESCE(${gateEvents.detail}, '{}'::jsonb),
              '{coalesced}',
              to_jsonb(COALESCE((${gateEvents.detail} ->> 'coalesced')::int, 0) + 1)
            ),
            '{coalescedChanges}',
            COALESCE(${gateEvents.detail} -> 'coalescedChanges', '[]'::jsonb)
              || ${JSON.stringify([{ prNumber: change.prNumber ?? null, sha: change.sha ?? null, files: files.slice(0, 50) }])}::jsonb
          )`,
        })
        .where(eq(gateEvents.id, noticeId));
    },

    queueInstruction(workerId, text, marker) {
      return queueSystemInstruction(workerId, text, { marker, sensitive: sensitive.get(workerId) ?? false });
    },

    async recordNotice(rec) {
      await recordGateEvent({
        gate: GATE_SLUGS.BASE_ADVANCE_NOTICE,
        surface: BASE_ADVANCE_SURFACE,
        outcome: 'warned',
        reason: NOTICE_REASON,
        workspaceId: rec.workspaceId,
        missionId: rec.missionId,
        taskId: rec.taskId,
        workerId: rec.workerId,
        callerOrigin: 'system',
        detail: {
          baseRef: rec.baseRef,
          repoFullName: rec.repoFullName,
          source: rec.source,
          strategy: rec.strategy,
          prNumber: rec.change.prNumber ?? null,
          sha: rec.change.sha ?? null,
          overlappingFiles: rec.overlappingFiles.slice(0, 50),
          overlapCount: rec.overlappingFiles.length,
        },
      });
    },
  };
}

/** Webhook entry point. Never throws: a notice is a nicety, the webhook is the contract. */
export async function runBaseAdvanceNotice(input: BaseAdvanceInput, resolver: BaseResolver): Promise<BaseAdvanceResult> {
  try {
    const out = await notifyBaseAdvance(input, createBaseAdvanceStore(resolver));
    if (out.notified.length > 0 || out.debounced.length > 0) {
      console.log(
        `[base-advance] ${input.repoFullName}@${input.baseRef} (${input.source}): `
        + `notified ${out.notified.length}, debounced ${out.debounced.length}`,
      );
    }
    return out;
  } catch (err) {
    console.error(`[base-advance] ${input.repoFullName}@${input.baseRef} failed:`, err);
    return { notified: [], debounced: [] };
  }
}

/** Cap on files read from GitHub per change: 3 pages of 100. */
const MAX_FILE_PAGES = 3;

function filenames(list: unknown): string[] {
  return Array.isArray(list)
    ? list.map(f => (f as { filename?: unknown })?.filename).filter((f): f is string => typeof f === 'string')
    : [];
}

/** Files a merged PR changed (`pulls/{n}/files`, up to 300). */
export async function changedFilesForPr(installationId: number, repoFullName: string, prNumber: number): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = filenames(await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`));
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Files changed between two commits (`compare/{before}...{after}`; GitHub caps at 300). */
export async function changedFilesForCompare(installationId: number, repoFullName: string, before: string, after: string): Promise<string[]> {
  const cmp = await githubApi(installationId, `/repos/${repoFullName}/compare/${before}...${after}`);
  return filenames((cmp as { files?: unknown })?.files);
}
