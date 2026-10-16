'use client';

import SpecDelivery from '@/components/SpecDelivery';
import { deliveredSentence, standingSentence, type CriterionMark, type DeliveryOutcome } from '@/lib/specs/delivery-words';
import type { DeliveryEntry, SpecDelivery as SpecDeliveryData } from '@/lib/specs/delivery';

/**
 * A spec's Delivery and verification section with mission entries beside a
 * task entry (living-specs Slice 13), for Visual QA at phone width: a mission
 * that selects a spec as its outcome spec is newer than the scrubbed QA clone,
 * so a real spec page cannot show one. Nothing here is fetched; the sentences
 * come from the same helpers the page uses.
 */
const APPROVED = 2;
const AT = '2026-10-14T12:00:00.000Z';

function entry(e: {
  kind: DeliveryEntry['kind']; id: string; title: string; builtTo: number; delivered: boolean; outcome: DeliveryOutcome;
  criteria: Array<{ criterionId: string; text: string; mark: CriterionMark }>;
  waivedBy?: Array<{ criterionId: string; by: string }>; links?: DeliveryEntry['links'];
}): DeliveryEntry {
  return {
    kind: e.kind, id: e.id, title: e.title,
    href: e.kind === 'mission' ? `/app/missions/${e.id}` : `/app/tasks/${e.id}`,
    builtTo: e.builtTo, provisional: false, delivered: e.delivered,
    deliveredText: deliveredSentence({ builtTo: e.builtTo, provisional: false, delivered: e.delivered }),
    standing: standingSentence({ builtTo: e.builtTo, approved: APPROVED, outcome: e.outcome, criteria: e.criteria, waivedBy: e.waivedBy }),
    criteria: e.criteria.map((c) => ({ ...c, evidence: c.mark === 'pass' ? [{ label: 'ci', href: 'https://example.test/run/1' }] : [] })),
    links: e.links ?? [],
    at: AT,
  };
}

export const SPEC_DELIVERY_FIXTURE: SpecDeliveryData = {
  entries: [
    entry({
      kind: 'mission', id: 'fixture-mission-euros', title: 'Checkout in the shopper currency', builtTo: 2, delivered: true, outcome: 'verified',
      criteria: [
        { criterionId: 'AC-1', text: 'Totals are in the shopper currency.', mark: 'pass' },
        { criterionId: 'AC-2', text: 'A EUR cart shows the euro sign before the amount.', mark: 'waived' },
        { criterionId: 'AC-3', text: 'A failed payment keeps the cart.', mark: 'pass' },
      ],
      waivedBy: [{ criterionId: 'AC-2', by: 'Ada Lovelace' }],
      links: [{ label: 'Final verification', href: '/app/tasks/fixture-final-check' }],
    }),
    entry({
      kind: 'mission', id: 'fixture-mission-refunds', title: 'Refunds return to the original payment method', builtTo: 2, delivered: false, outcome: 'fail',
      criteria: [
        { criterionId: 'AC-4', text: 'A refund goes back to the card it came from.', mark: 'fail' },
        { criterionId: 'AC-5', text: 'The shopper gets a receipt for the refund.', mark: 'none' },
      ],
    }),
    entry({
      kind: 'mission', id: 'fixture-mission-cart', title: 'Empty cart state', builtTo: 1, delivered: true, outcome: 'verified',
      criteria: [{ criterionId: 'AC-6', text: 'An empty cart shows the empty state.', mark: 'pass' }],
    }),
    entry({
      kind: 'task', id: 'fixture-task-rounding', title: 'Round totals the way the payment provider rounds', builtTo: 2, delivered: true, outcome: 'unverified',
      criteria: [{ criterionId: 'AC-1', text: 'Totals are in the shopper currency.', mark: 'stale' }],
      links: [{ label: 'PR #12', href: 'https://github.com/acme/shop/pull/12' }],
    }),
  ],
  next: null,
};

export default function SpecDeliveryFixture() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="spec-delivery-fixture">
      <SpecDelivery specId="fixture-spec" delivery={SPEC_DELIVERY_FIXTURE} />
    </main>
  );
}
