import type { TaskModelSummary } from '@/lib/model-presentation';

/**
 * The MODEL cell of the task Details disclosure.
 *
 * Tier is the primary label and the concrete id sits under it in mono, the same
 * primary-over-mono idiom `ModelPicker` and the Task ID cell already use. The
 * resolution source is here because "why did it pick this?" is the question
 * people actually ask, and it is the only field that answers it.
 *
 * Divergence — the SDK reporting a different model than the one assigned — is
 * muted, not coloured: a fallback firing is normal, only the fleet aggregate is
 * alarming, and a status colour here would compete with StageChip.
 */
export default function TaskModelCell({ summary }: { summary: TaskModelSummary }) {
  if (summary.isEmpty) return null;

  return (
    <div>
      <dt className="text-text-muted text-[11px] uppercase tracking-wider">Model</dt>
      <dd className="text-text-primary">
        {summary.tierLabel ?? summary.modelLabel}
        {summary.source && <span className="text-text-muted"> &middot; {summary.source}</span>}
      </dd>
      {summary.modelId && (
        <dd className="text-text-muted font-mono text-[11px] break-all">{summary.modelId}</dd>
      )}
      {summary.divergedTo && (
        <dd className="text-text-muted text-[11px]">Ran on {summary.divergedTo}</dd>
      )}
    </div>
  );
}
