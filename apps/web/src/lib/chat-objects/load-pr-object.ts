/**
 * A pull request as a live chat object, from the worker that opened it.
 *
 * The ref id may name the worker or the task: a worker id resolves directly; a
 * task id resolves to that task's newest worker with a PR. The chat contract's
 * own PR id, `"{owner}/{repo}#{n}"`, resolves through `workers.prUrl` (a PR's
 * repo lives in its URL, never in the free-text workspace column).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, isNotNull, like } from 'drizzle-orm';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import type { PrObjectView } from '@/components/chat/objects/object-views';
import { resolvePrDisplayState, type PrDisplayState } from '@/lib/pr-presentation';
import { getOwnerDeliveryDisplays } from '@/lib/workflow/delivery-view';

/**
 * The PR's display state, projected onto the chat object's vocabulary. Pure.
 * A kernel-owned PR reads its delivery (`resolvePrDisplayState`), never the
 * worker's fact-cache columns (§17.5).
 */
export function prStateOf(
  prLifecycleStatus: string | null | undefined,
  mergedAt: unknown,
  delivery?: { prState: PrDisplayState | null } | null,
): PrObjectView['state'] {
  const state = resolvePrDisplayState({ delivery, prLifecycleStatus, mergedAt });
  switch (state) {
    case 'unresolvable': return 'closed';
    case 'awaiting_ci': return 'open';
    default: return state;
  }
}

const epoch = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

const PR_WORKER_COLUMNS = {
  id: true, taskId: true, prNumber: true, prUrl: true, prLifecycleStatus: true, mergedAt: true,
  linesAdded: true, linesRemoved: true,
} as const;

/** `"harborline/billing-web#413"` → its repo and number; null for anything else. Pure. */
export function parsePrRefId(id: string): { repo: string; number: number } | null {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(id);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** Escape LIKE wildcards in a literal. Pure. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

export async function loadPrObject(id: string, userId: string): Promise<PrObjectView | null> {
  const slug = parsePrRefId(id);
  if (slug) {
    const w = await db.query.workers.findFirst({
      where: and(eq(workers.prNumber, slug.number), like(workers.prUrl, `%/${likeLiteral(slug.repo)}/pull/${slug.number}`)),
      orderBy: desc(workers.createdAt),
      columns: PR_WORKER_COLUMNS,
    });
    return w ? prViewFromWorker(id, w, userId) : null;
  }
  const [byWorker, byTask] = await Promise.all([
    db.query.workers.findFirst({ where: eq(workers.id, id), columns: PR_WORKER_COLUMNS }),
    db.query.workers.findFirst({
      where: and(eq(workers.taskId, id), isNotNull(workers.prNumber)),
      orderBy: desc(workers.createdAt),
      columns: PR_WORKER_COLUMNS,
    }),
  ]);
  const w = byWorker?.prNumber != null ? byWorker : byTask;
  return w ? prViewFromWorker(id, w, userId) : null;
}

type PrWorkerRow = {
  id: string; taskId: string | null; prNumber: number | null; prUrl: string | null; prLifecycleStatus: string | null;
  mergedAt: Date | string | null; linesAdded: number | null; linesRemoved: number | null;
};

async function prViewFromWorker(id: string, w: PrWorkerRow, userId: string): Promise<PrObjectView | null> {
  if (w.prNumber == null || !w.taskId) return null;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, w.taskId),
    columns: { id: true, title: true, workspaceId: true, missionId: true },
  });
  if (!task) return null;
  if (!(await verifyWorkspaceAccess(userId, task.workspaceId))) return null;
  const delivery = (await getOwnerDeliveryDisplays([task.id])).get(task.id) ?? null;

  return {
    kind: 'pr',
    id,
    workspaceId: task.workspaceId,
    number: w.prNumber,
    url: w.prUrl ?? null,
    title: task.title,
    state: prStateOf(w.prLifecycleStatus, w.mergedAt, delivery),
    linesAdded: w.linesAdded ?? null,
    linesRemoved: w.linesRemoved ?? null,
    mergedAt: epoch(w.mergedAt),
    taskId: task.id,
    missionId: task.missionId ?? null,
    renderedAt: Date.now(),
  };
}
