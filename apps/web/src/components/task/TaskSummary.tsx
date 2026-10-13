import type { ReactNode } from 'react';
import MarkdownContent from '@/components/MarkdownContent';
import AiFeedback from '@/components/AiFeedback';

export interface TaskSummaryProps {
  summary: string;
  /** Stable id for the AiFeedback thumbs (e.g. `task-<id>-summary`). */
  entityId: string;
  /** Taken from the worker's last message, not written by it (`isFallbackSummary`). */
  fallback?: boolean;
  /** Section label above the card. Omit when the surface heads it already. */
  label?: string;
  /** Inline under a deliverables bar instead of in its own card. */
  framed?: boolean;
  /** Beside the feedback thumbs (the page's share control). */
  actions?: ReactNode;
}

/**
 * A task's outcome summary: markdown with feedback thumbs, marked when it is
 * only the worker's last message. The task page and the mission task sheet
 * both render it, so a summary reads the same in each.
 */
export default function TaskSummary({ summary, entityId, fallback = false, label, framed = true, actions }: TaskSummaryProps) {
  const chip = fallback && (
    <div className="mb-2">
      <span data-testid="task-summary-fallback" className="font-mono text-chip border border-border-default text-text-muted px-1 py-px shrink-0">
        unauthored · last message
      </span>
    </div>
  );
  if (!framed) {
    return (
      <div className="text-sm text-text-secondary mt-2">
        {chip}
        <MarkdownContent content={summary} />
        <div className="mt-2 flex justify-end">
          <AiFeedback entityType="summary" entityId={entityId} compact />
        </div>
      </div>
    );
  }
  return (
    <div>
      {label && <div className="section-label mb-2">{label}</div>}
      <div className="p-5 bg-surface-2 border border-border-default">
        {chip}
        <MarkdownContent content={summary} />
        <div className="mt-3 pt-2 border-t border-border-default/50 flex items-center justify-between gap-3">
          <AiFeedback entityType="summary" entityId={entityId} />
          {actions}
        </div>
      </div>
    </div>
  );
}
