import Link from 'next/link';
import Card from '@/components/ui/Card';
import { MarkedWords } from '@/components/SpecReviewChanges';
import { wordDiff } from '@buildd/spec-contract/criterion-review';
import type { CriterionHistory } from '@/lib/specs/criteria';

const KIND = { added: 'Added', changed: 'Changed', restored: 'Restored' } as const;

/**
 * One criterion's history ("Reviewing a spec revision" R-12, R-15): each
 * revision in which its words changed, newest first, with what changed from
 * the wording before it, the author's change summary, who wrote it and
 * whether that wording was approved. A criterion that replaces others
 * continues their history.
 */
export default function SpecCriterionHistory({ specId, criterionId, history }: { specId: string; criterionId: string; history: CriterionHistory | null }) {
  const close = `/app/specs/${specId}#${criterionId}`;
  const entries = history ? [...history.entries].reverse() : [];
  return (
    <Card as="section" id="criterion-history" aria-labelledby="criterion-history-heading" className="flex scroll-mt-6 flex-col gap-3" data-testid="spec-criterion-history">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="criterion-history-heading" className="text-title font-semibold text-text-primary">History of {criterionId}</h2>
        <Link href={close} className="inline-flex min-h-11 items-center text-meta text-text-secondary underline md:min-h-0">Close</Link>
      </div>
      {!history ? (
        <p className="text-body text-text-secondary">Criterion never defined: {criterionId}.</p>
      ) : (
        <>
          {history.replaces.length ? <p className="text-meta text-text-muted">Continues {history.replaces.join(', ')}, which it replaces.</p> : null}
          <ol className="flex flex-col divide-y divide-[var(--line-soft)]">
            {entries.map((e, i) => {
              // The wording before this one in the history (older), to mark what changed.
              const prev = entries[i + 1];
              return (
                <li key={`${e.criterionId}:${e.revision}`} className="flex flex-col gap-1 py-2" data-testid="spec-criterion-history-entry" data-revision={e.revision}>
                  <span className="flex flex-wrap items-baseline gap-x-2 text-meta text-text-muted">
                    <Link href={`/app/specs/${specId}?revision=${e.revision}#${e.criterionId}`} className="font-medium text-text-primary underline">Revision {e.revision}</Link>
                    <span>{KIND[e.kind]}{e.criterionId !== criterionId ? ` as ${e.criterionId}` : ''}</span>
                    <span>by {e.author === 'person' ? 'a person' : 'an agent'}</span>
                    {e.approved ? <span className="font-medium text-status-success">approved</span> : <span>not approved</span>}
                  </span>
                  <p className="whitespace-pre-line text-body text-text-primary [overflow-wrap:anywhere]">
                    {prev && e.kind === 'changed' ? <MarkedWords words={wordDiff(prev.text, e.text)} /> : e.text}
                  </p>
                  {e.changeSummary ? <p className="text-meta text-text-secondary [overflow-wrap:anywhere]">{e.changeSummary}</p> : null}
                </li>
              );
            })}
          </ol>
          {history.retiredIn ? (
            <p className="text-meta text-text-muted" data-testid="spec-criterion-history-retired">
              Retired in revision {history.retiredIn}{history.replacedBy ? `, replaced by ${history.replacedBy}` : ''}. The id is not used again.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
