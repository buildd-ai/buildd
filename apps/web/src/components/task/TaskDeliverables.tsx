/**
 * A task's Deliverables, as the task page and the mission sheet both show
 * them: the summary, the code bar (branch, commits, diff, PR) and any
 * structured output. A PR card on the same surface already shows the diff
 * (`prCard`); on the page it also carries the summary (`summaryInPrCard`).
 */
import TaskSummary from '@/components/task/TaskSummary';
import ArtifactShareControl from '@/components/ArtifactShareControl';
import { hasCodeDeliverables } from '@/app/app/(protected)/tasks/[id]/deliverables';
import { isFallbackSummary } from '@/lib/task-sections';

export interface TaskDeliverablesResult {
  summary?: string;
  summarySource?: string;
  branch?: string;
  commits?: number;
  sha?: string;
  files?: number;
  added?: number;
  removed?: number;
  prUrl?: string;
  prNumber?: number;
  structuredOutput?: Record<string, unknown>;
}

export interface SuppressedSummary {
  id: string;
  visibility?: string | null;
  shareToken: string | null;
}

export default function TaskDeliverables({
  taskId,
  result,
  prCard,
  summaryInPrCard = false,
  suppressedSummary = null,
  baseUrl,
}: {
  taskId: string;
  result: TaskDeliverablesResult | null;
  prCard: boolean;
  summaryInPrCard?: boolean;
  /** A summary artifact that only repeated the summary: shared from here instead. */
  suppressedSummary?: SuppressedSummary | null;
  baseUrl: string;
}) {
  if (!result) return null;
  const hasCode = hasCodeDeliverables(result);
  const fallback = isFallbackSummary(result);
  const showCodeBar = hasCode && !prCard;
  const showSummary = !!result.summary && !showCodeBar && !(hasCode && prCard && summaryInPrCard);
  if (!showCodeBar && !showSummary && !result.structuredOutput) return null;

  return (
    <div className="mb-8" data-testid="task-deliverables">
      <div className="section-label pb-2 border-b border-border-default mb-4">
        Deliverables
      </div>

      {showSummary && (
        <div className="mb-4">
          <TaskSummary
            summary={result.summary!}
            entityId={`task-${taskId}-summary`}
            fallback={fallback}
            actions={suppressedSummary && (
              <div className="flex items-center gap-2">
                <ArtifactShareControl
                  artifactId={suppressedSummary.id}
                  baseUrl={baseUrl}
                  initialVisibility={(suppressedSummary.visibility as 'private' | 'public') ?? 'private'}
                  initialShareToken={suppressedSummary.shareToken}
                />
                <a
                  href={`/app/artifacts/${suppressedSummary.id}`}
                  className="text-[11px] text-text-muted hover:text-text-secondary"
                >
                  Open ↗
                </a>
              </div>
            )}
          />
        </div>
      )}

      {showCodeBar && (
        <div className="p-4 bg-surface-2 border border-border-default">
          <div className="flex items-center gap-3 text-sm flex-wrap">
            {result.branch && (
              <code className="px-2 py-0.5 border border-border-default font-mono text-xs text-text-secondary">
                {result.branch}
              </code>
            )}
            {(result.commits ?? 0) > 0 && (
              <span className="text-text-secondary text-xs">
                {result.commits} commit{result.commits !== 1 ? 's' : ''}
              </span>
            )}
            {((result.added ?? 0) > 0 || (result.removed ?? 0) > 0) && (
              <span className="text-xs">
                <span className="text-status-success">+{result.added}</span>
                <span className="text-status-error">/{'-'}{result.removed}</span>
              </span>
            )}
            {(result.files ?? 0) > 0 && (
              <span className="text-xs text-text-secondary">{result.files} files</span>
            )}
            {result.sha && (
              <code className="font-mono text-xs text-text-muted">{result.sha.slice(0, 7)}</code>
            )}
            {result.prUrl && (
              <a
                href={result.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-[5px] text-xs border border-border-default text-accent-text hover:bg-surface-3"
              >
                PR #{result.prNumber}
              </a>
            )}
          </div>
          {result.summary && (
            <TaskSummary summary={result.summary} entityId={`task-${taskId}-summary`} fallback={fallback} framed={false} />
          )}
        </div>
      )}

      {result.structuredOutput && (
        <div className="mt-4">
          <div className="section-label mb-2">
            Output
          </div>
          <pre className="p-4 bg-surface-2 border border-border-default overflow-x-auto text-sm font-mono text-text-primary">
            {JSON.stringify(result.structuredOutput, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
