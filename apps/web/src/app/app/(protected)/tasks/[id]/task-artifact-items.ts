/**
 * The task page's artifact rows, as the client section and the viewer read
 * them. `storageKey` is carried from its own column: upload-url stores the
 * object key there, and without it an uploaded screenshot has nothing to show.
 */
import { isSummaryDuplicate } from '@/components/artifact-helpers';
export interface TaskArtifactItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  storageKey: string | null;
  shareToken: string | null;
  visibility: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  storageKey?: string | null;
  shareToken: string | null;
  visibility?: string | null;
  metadata?: unknown;
  createdAt: Date | string;
}

export function toTaskArtifactItem(a: ArtifactRow): TaskArtifactItem {
  const metadata =
    a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
      ? (a.metadata as Record<string, unknown>)
      : {};
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    content: a.content,
    storageKey: a.storageKey ?? null,
    shareToken: a.shareToken,
    visibility: a.visibility === 'public' ? 'public' : 'private',
    metadata,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : a.createdAt.toISOString(),
  };
}

/**
 * Which of a task's artifacts its artifacts list shows, for the page and the
 * sheet alike: never the plan, and not a lone summary artifact that only
 * repeats the result's summary (it is shown as the summary instead), unless
 * the task leads with what shipped, where the raw handoff moves aside.
 */
export function taskVisibleArtifacts<A extends { id: string; type: string; content: string | null }>(
  artifacts: readonly A[],
  task: { status: string; mode: string | null; result: unknown },
): { visible: A[]; suppressedSummary: A | null } {
  const deliverable = artifacts.filter(a => a.type !== 'impl_plan');
  const leadsWithShipped = task.status === 'completed' && task.mode !== 'planning';
  const resultSummary = (task.result as { summary?: unknown } | null)?.summary;
  const summaries = deliverable.filter(a => a.type === 'summary');
  const suppressedSummary =
    !leadsWithShipped && typeof resultSummary === 'string' && resultSummary && summaries.length === 1 && isSummaryDuplicate(summaries[0].content, resultSummary)
      ? summaries[0]
      : null;
  return { visible: suppressedSummary ? deliverable.filter(a => a.id !== suppressedSummary.id) : deliverable, suppressedSummary };
}
