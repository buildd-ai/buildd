import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { parseRiskFilter } from '@buildd/spec-contract/risk-tier';
import { reviewAllView } from '@/lib/specs/review-all-view';
import { SPEC_APPROVAL_INBOX_PATH, SPEC_REVIEW_ALL_PATH } from '@/lib/specs/approval-inbox';
import SpecReviewAll from '@/components/SpecReviewAll';
import Lede from '@/components/ui/Lede';

export const dynamic = 'force-dynamic';

/**
 * Review all (Living Spec b7fc9316 R-24 to R-26): the Awaiting your approval
 * inbox on one page. Each revision reads as one line and opens to its diff;
 * one Approve all confirms each under its own signed request, minted here for
 * exactly the revision, version and hash rendered.
 */
export default async function SpecReviewAllPage({ searchParams }: { searchParams: Promise<{ tier?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(SPEC_REVIEW_ALL_PATH)}`);
  const { tier } = await searchParams;
  const { rows, more, counts, filter } = await reviewAllView(user.id, parseRiskFilter(tier));
  const n = rows.length;
  const waiting = counts.high + counts.medium + counts.low;
  return (
    <main className="px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-heading font-semibold text-text-primary">Review all</h1>
        <Lede>
          <span data-testid="spec-review-all-lede">
            {waiting === 0
              ? 'Nothing waits for your approval.'
              : n === 0
              ? `Nothing waits in this tier. ${waiting} wait in the others.`
              : `${n} spec ${n === 1 ? 'revision waits' : 'revisions wait'} for you. Read each line, open any diff, then approve them together.`}
            {' '}
            <Link href={SPEC_APPROVAL_INBOX_PATH} className="text-accent-text underline-offset-2 hover:underline">Review one at a time</Link>
          </span>
        </Lede>
        {more > 0 ? (
          <p className="text-meta text-text-secondary" data-testid="spec-review-all-more">
            {more} more {more === 1 ? 'waits' : 'wait'} after these; approve these first, then reload.
          </p>
        ) : null}
        {waiting > 0 ? <SpecReviewAll rows={rows} counts={counts} filter={filter} /> : null}
      </div>
    </main>
  );
}
