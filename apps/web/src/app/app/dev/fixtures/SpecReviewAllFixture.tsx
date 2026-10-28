'use client';

import { useEffect, useState } from 'react';
import SpecReviewAll from '@/components/SpecReviewAll';
import Lede from '@/components/ui/Lede';
import type { ReviewAllRow } from '@/lib/specs/review-all-view';
import type { ApproveAllResult } from '@/lib/specs/approve-all';

/**
 * The Review all page (/app/specs/review-all, Living Spec b7fc9316 R-24 to
 * R-26) without a database: four waiting revisions, `&v=diff` with the first
 * diff open, `&v=result` after Approve all with one revision gone stale.
 */
export const SPEC_REVIEW_ALL_VARIANTS = ['list', 'diff', 'result'] as const;
export type SpecReviewAllVariant = (typeof SPEC_REVIEW_ALL_VARIANTS)[number];

const row = (n: number, title: string, summary: string | null, approvedRevision: number | null, rows: ReviewAllRow['diff']): ReviewAllRow => ({
  specId: `fixture-spec-${n}`, title, workspaceName: 'Shop', headRevision: (approvedRevision ?? 0) + 1, approvedRevision,
  author: n % 2 ? 'an agent' : 'Sam Rivera', summary, request: `fixture-request-${n}`, diff: rows,
});

export const SPEC_REVIEW_ALL_ROWS: ReviewAllRow[] = [
  row(1, 'Checkout', 'Shoppers can cancel from the confirmation email until the order is packed.', 2, {
    linesAdded: 2, linesRemoved: 1, omittedLines: 0,
    hunks: [{ kind: 'changed', path: 'Checkout > Cancelling', linesAdded: 2, linesRemoved: 1, rows: [
      { op: ' ', oldLine: 58, newLine: 58, text: '## Cancelling' },
      { op: '-', oldLine: 60, newLine: null, text: '- R-12: An order can be cancelled until it is packed.' },
      { op: '+', oldLine: null, newLine: 60, text: '- R-12: An order can be cancelled until it is packed, from the order page.' },
      { op: '+', oldLine: null, newLine: 61, text: '- R-13: An order can be cancelled from the confirmation email until it is packed.' },
    ] }],
  }),
  row(2, 'Refunds to the original card, before and after packing', 'Refunds after packing wait for the parcel to come back.', 4, {
    linesAdded: 1, linesRemoved: 1, omittedLines: 0,
    hunks: [{ kind: 'changed', path: 'Refunds > After packing', linesAdded: 1, linesRemoved: 1, rows: [
      { op: '-', oldLine: 22, newLine: null, text: '- AC-4: GIVEN a packed order WHEN I cancel THEN the refund is issued at once.' },
      { op: '+', oldLine: null, newLine: 22, text: '- AC-4: GIVEN a packed order WHEN I cancel THEN the refund is issued when the parcel is back.' },
    ] }],
  }),
  row(3, 'Receipts', null, 1, {
    linesAdded: 1, linesRemoved: 0, omittedLines: 0,
    hunks: [{ kind: 'changed', path: 'Receipts > Requirements', linesAdded: 1, linesRemoved: 0, rows: [
      { op: '+', oldLine: null, newLine: 9, text: '- R-4: A receipt names the shop\'s tax number.' },
    ] }],
  }),
  row(4, 'Gift cards', 'First draft: buying, sending and spending a gift card.', null, {
    linesAdded: 3, linesRemoved: 0, omittedLines: 0,
    hunks: [{ kind: 'added', path: 'Gift cards', linesAdded: 3, linesRemoved: 0, rows: [
      { op: '+', oldLine: null, newLine: 1, text: '# Gift cards' },
      { op: '+', oldLine: null, newLine: 2, text: '' },
      { op: '+', oldLine: null, newLine: 3, text: '- R-1: A gift card is spent like money at checkout.' },
    ] }],
  }),
];

const item = (r: ReviewAllRow) => ({ specId: r.specId, title: r.title, revision: r.headRevision, request: r.request! });
export const SPEC_REVIEW_ALL_RESULT: ApproveAllResult = {
  outcomes: [
    { item: item(SPEC_REVIEW_ALL_ROWS[0]!), outcome: 'approved' },
    { item: item(SPEC_REVIEW_ALL_ROWS[1]!), outcome: 'stale', headRevision: 6 },
    { item: item(SPEC_REVIEW_ALL_ROWS[2]!), outcome: 'approved' },
    { item: item(SPEC_REVIEW_ALL_ROWS[3]!), outcome: 'approved' },
  ],
  approved: 3, stale: 1, other: 0,
};

export const parseSpecReviewAllVariant = (raw: string | null): SpecReviewAllVariant =>
  (SPEC_REVIEW_ALL_VARIANTS as readonly string[]).includes(raw ?? '') ? raw as SpecReviewAllVariant : 'list';

export default function SpecReviewAllFixture() {
  const [variant, setVariant] = useState<SpecReviewAllVariant>('list');
  useEffect(() => {
    setVariant(parseSpecReviewAllVariant(new URLSearchParams(window.location.search).get('v')));
  }, []);
  const n = SPEC_REVIEW_ALL_ROWS.length;
  // The page's own wrapper (specs/review-all/page.tsx).
  return (
    <main className="px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10" data-testid="spec-review-all-fixture" data-variant={variant}>
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-heading font-semibold text-text-primary">Review all</h1>
        <Lede>
          {`${n} spec revisions wait for you. Read each line, open any diff, then approve them together.`}{' '}
          <span className="text-accent-text">Review one at a time</span>
        </Lede>
        <SpecReviewAll
          key={variant}
          rows={SPEC_REVIEW_ALL_ROWS}
          initialResult={variant === 'result' ? SPEC_REVIEW_ALL_RESULT : null}
          openSpecId={variant === 'diff' ? SPEC_REVIEW_ALL_ROWS[0]!.specId : null}
        />
      </div>
    </main>
  );
}
