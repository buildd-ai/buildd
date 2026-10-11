/**
 * What the task page reads about the delivery a task belongs to
 * (docs/specs/task-page.md): the kernel's DeliveryView, the deliverable's
 * title (for an attempt's "Review of:" link), and each review round's findings
 * read for people. One call, so the page keeps a single serial wait for it.
 * Never throws: a read failure leaves the page on its legacy projections.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { readableTaskResult, type ReadableResult } from './task-result';
import { getDeliveryViewsForTasks } from './workflow/delivery-view';
import type { DeliveryView } from './workflow/projections';

export interface TaskDeliveryContext {
  view: DeliveryView | null;
  /** The deliverable's title, when this task is an attempt of it. */
  deliverableTitle: string | null;
  /** reviewer task id → its findings. */
  findings: Map<string, Pick<ReadableResult, 'prose' | 'verdict'>>;
}

export async function loadTaskDeliveryContext(taskId: string): Promise<TaskDeliveryContext> {
  const view = (await getDeliveryViewsForTasks([taskId])).get(taskId) ?? null;
  const findings = new Map<string, Pick<ReadableResult, 'prose' | 'verdict'>>();
  if (!view) return { view, deliverableTitle: null, findings };
  const reviewerIds = view.rounds.map(r => r.reviewerTaskId).filter((id): id is string => !!id);
  const ids = [...new Set([...reviewerIds, view.ownerTaskId])];
  let deliverableTitle: string | null = null;
  try {
    const rows = await db.query.tasks.findMany({ where: inArray(tasks.id, ids), columns: { id: true, title: true, result: true } });
    for (const r of rows) {
      if (r.id === view.ownerTaskId) deliverableTitle = r.title;
      if (!reviewerIds.includes(r.id)) continue;
      const res = (r.result ?? null) as { summary?: unknown; structuredOutput?: unknown } | null;
      const { prose, verdict } = readableTaskResult(res?.summary, res?.structuredOutput);
      findings.set(r.id, { prose, verdict });
    }
  } catch (err) {
    console.warn('[task-page] review findings unavailable:', err instanceof Error ? err.message : err);
  }
  return { view, deliverableTitle, findings };
}
