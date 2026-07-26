import MarkdownContent from '@/components/MarkdownContent';
import AiFeedback from '@/components/AiFeedback';

export interface TaskSummaryProps {
  summary: string;
  /** Stable id for the AiFeedback thumbs (e.g. `task-<id>-summary`). */
  entityId: string;
  /** Header label above the summary. Omit to render the body only. */
  label?: string;
}

/**
 * A task's outcome summary rendered as markdown with feedback thumbs. Shared by
 * the task detail page and the mission task drawer so the summary reads the same
 * in both (the drawer previously rendered raw text; this unifies on markdown).
 */
export default function TaskSummary({ summary, entityId, label }: TaskSummaryProps) {
  return (
    <div>
      {label && (
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">{label}</span>
      )}
      <div className={label ? 'mt-1 text-[13px] text-text-secondary leading-relaxed' : 'text-[13px] text-text-secondary leading-relaxed'}>
        <MarkdownContent content={summary} />
      </div>
      <div className="mt-1.5 flex justify-end">
        <AiFeedback entityType="summary" entityId={entityId} compact />
      </div>
    </div>
  );
}
