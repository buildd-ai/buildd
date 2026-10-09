/**
 * The delivery chip, the Build › Audit › Land track and the audit evidence
 * cards, shared by every surface that renders lib/delivery-projection.ts
 * (Home, Activity, mission detail). One vocabulary, one rendering: glyph and
 * word, never colour alone.
 */
import type { EvidenceEntry, StageNotes } from '@/lib/activity-delivery';
import {
  DELIVERY_KIND, DELIVERY_STAGES, deliveryStageIndex, repairBadge,
  type DeliveryKind, type DeliveryTone,
} from '@/lib/delivery-projection';

export const TONE_TEXT: Record<DeliveryTone, string> = {
  success: 'text-status-success', info: 'text-status-info', warning: 'text-status-warning',
  ink: 'text-text-primary', muted: 'text-text-muted', error: 'text-status-error',
};

/** Glyph and word in the kind's tone, unframed: a status, not a button. */
export function DeliveryChip({ kind }: { kind: DeliveryKind }) {
  const k = DELIVERY_KIND[kind];
  return (
    <span data-testid="delivery-chip" data-kind={kind} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-meta ${TONE_TEXT[k.tone]}`}>
      <span aria-hidden="true">{k.glyph}</span>{k.label}
    </span>
  );
}

/** Build › Audit › Land in words: ✓ for passed stages, the current one underlined. Repair shows as `Audit ↻N`. */
export function DeliveryTrack({ kind, rounds }: { kind: DeliveryKind; rounds: number }) {
  const at = deliveryStageIndex(kind);
  const current = DELIVERY_STAGES[Math.max(0, Math.min(2, at))];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-meta" aria-label={at < 0 ? 'Not started' : at > 2 ? 'Landed' : `Stage: ${current}`}>
      {DELIVERY_STAGES.map((name, i) => {
        const done = at > i;
        const cur = at === i;
        const text = done ? `✓ ${name}` : cur && i === 1 && rounds > 0 ? `${name} ${repairBadge(rounds)}` : name;
        return (
          <span key={name} className="inline-flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="text-text-muted">›</span>}
            <span className={done ? 'text-text-secondary' : cur ? 'font-semibold text-text-primary underline underline-offset-4' : 'text-text-muted'}>{text}</span>
          </span>
        );
      })}
    </span>
  );
}

const REPAIR_REASON = { ci: 'CI failed', conflict: 'conflict with its base', review: 'review notes' } as const;
const REPAIR_STATUS = { running: 'agent fixing now', pushed: 'pushed', failed: 'did not finish', queued: 'queued for a free slot' } as const;

/**
 * One evidence entry: a revision card (its gates, the current head framed) or
 * the repair between two heads. Activity's rows and mission detail's drawer
 * both render it, so a repair reads the same on both.
 */
export function DeliveryEvidence({ entry }: { entry: EvidenceEntry }) {
  if (entry.type === 'repair') {
    return (
      <div data-testid="activity-repair" className="ml-2.5 mt-2 border-l-2 border-dashed border-status-warning px-2.5 py-1.5 text-meta text-text-secondary">
        <span className="font-semibold text-status-warning">↻ Repair {entry.round}</span>
        {' · automatic'}
        {entry.reason && ` · ${REPAIR_REASON[entry.reason]}`}
        {` · ${REPAIR_STATUS[entry.status]}`}
        {entry.sha && ` ${entry.sha}`}
      </div>
    );
  }
  return (
    <div data-testid="activity-revision" data-current={entry.current} className={`mt-2 bg-[var(--chat-surface)] px-3 py-2.5 ${entry.current ? 'border-2 border-border-strong' : 'border border-border-default opacity-80'}`}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-body font-semibold text-text-primary">
          {entry.sha ? <>Revision <span className="font-mono">{entry.sha}</span></> : 'Revision'}
          <span className="ml-1.5 text-meta font-normal text-text-muted">{entry.current ? 'current head' : 'older head'}</span>
        </span>
        <span className="text-meta text-text-muted">audit round {entry.round}</span>
      </div>
      {entry.gates.map((g, i) => (
        <div key={i} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-0.5">
          <span aria-hidden="true" className={TONE_TEXT[g.tone]}>{g.glyph}</span>
          <span className={`text-body ${g.void ? 'text-text-muted line-through' : 'text-text-primary'}`}>{g.name}</span>
          <span className={`text-right text-meta ${g.void ? 'text-text-muted line-through' : TONE_TEXT[g.tone]}`}>{g.result}</span>
          {g.why && <span className="col-start-2 col-end-4 text-meta text-text-muted">{g.why}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * Build | Audit | Land as three labelled cells with one phrase each: passed
 * stages ✓, the current one underlined, later ones muted. Repair is Audit with
 * its round in the phrase, never a fourth cell.
 */
export function DeliveryStages({ kind, stages }: { kind: DeliveryKind; stages: StageNotes }) {
  const at = deliveryStageIndex(kind);
  const tone = DELIVERY_KIND[kind].tone;
  const notes = [stages.build, stages.audit, stages.land];
  return (
    <div data-testid="delivery-stages" data-kind={kind} role="list" aria-label="Delivery stages" className="grid grid-cols-3 border border-border-default">
      {DELIVERY_STAGES.map((name, i) => {
        const done = at > i;
        const cur = at === i;
        return (
          <div
            key={name}
            role="listitem"
            data-testid="delivery-stage"
            data-stage={name.toLowerCase()}
            data-state={done ? 'done' : cur ? 'current' : 'later'}
            aria-current={cur ? 'step' : undefined}
            className={`min-w-0 px-2.5 py-2 ${i > 0 ? 'border-l border-border-default' : ''} ${cur ? `border-b-[3px] ${TONE_UNDERLINE[tone]}` : ''}`}
          >
            <div className={`font-mono text-chip font-semibold uppercase tracking-[1.4px] ${done ? 'text-status-success' : cur ? 'text-text-primary' : 'text-text-muted'}`}>
              {done && <span aria-hidden="true">✓ </span>}{name}
            </div>
            <div className={`font-mono text-meta [overflow-wrap:anywhere] ${at < i ? 'text-text-muted' : 'text-text-secondary'}`}>{notes[i]}</div>
          </div>
        );
      })}
    </div>
  );
}

const TONE_UNDERLINE: Record<DeliveryTone, string> = {
  success: 'border-b-status-success', info: 'border-b-status-info', warning: 'border-b-status-warning',
  ink: 'border-b-text-primary', muted: 'border-b-border-strong', error: 'border-b-status-error',
};
