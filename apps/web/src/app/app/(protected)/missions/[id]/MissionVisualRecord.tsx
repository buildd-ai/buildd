/**
 * The visual check's line in a mission's completion record: what was decided
 * about the screens, by whom, and under which policy. Three kinds, kept
 * visibly apart: a person's waiver (reason, who, when, policy), an automatic
 * "no visual changes" decision, and a pass. Nothing here is a finding.
 */
import { ZonedTime } from '@/components/DisplayTimezone';
import type { VisualReviewRecord } from '@/lib/workflow/visual-review-presentation';

const KIND_LABEL: Record<VisualReviewRecord['kind'], string> = {
  waiver: 'Waived by a person',
  auto_no_impact: 'Decided automatically',
  passed: 'Checked',
};

export default function MissionVisualRecord({ record }: { record: VisualReviewRecord }) {
  return (
    <section data-testid="mission-visual-record" data-kind={record.kind} aria-label="Visual check record" className="mt-3 flex flex-col gap-0.5 border-t border-border-default pt-3 text-meta">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-text-primary">{record.text}</span>
        <span className="font-mono text-eyebrow text-text-muted" data-testid="mission-visual-record-kind">{KIND_LABEL[record.kind]}</span>
      </p>
      {record.kind === 'waiver' ? (
        <>
          <p className="text-text-secondary [overflow-wrap:anywhere]" data-testid="mission-visual-record-reason">{record.reason}</p>
          <p className="font-mono text-text-muted" data-testid="mission-visual-record-by">
            {record.actor ? `${record.actor} · ` : ''}<ZonedTime value={record.at} format="datetime" fallback={record.at.slice(0, 10)} /> · {record.policy} policy
          </p>
        </>
      ) : record.detail ? (
        <p className="text-text-secondary">{record.detail}</p>
      ) : null}
    </section>
  );
}
