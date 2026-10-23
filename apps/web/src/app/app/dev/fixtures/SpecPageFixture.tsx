'use client';

import { useEffect, useState } from 'react';
import SpecPage from '@/components/SpecPage';
import SpecApprovalRequest from '@/components/SpecApprovalRequest';
import type { SpecPageView } from '@/lib/specs/page-view';
import type { ApprovalRequestView } from '@/lib/specs/approval-view';

/**
 * The spec page as a reader opens it, for Visual QA at 390 and 1440 wide
 * ("Spec page layout"): the scrubbed QA clone blanks spec bodies, so a real
 * spec shows an empty box and its reading goals (title and text above the
 * fold, Contents, the last line above the bar, the 720px column beside the
 * rail, no empty Comments or Files tab) cannot be judged. Nothing here is
 * fetched. `?state=spec-page&v=` one of
 * - `approved` (default): six sections and a long body, nothing waiting.
 * - `waiting`: approved at revision 2, revision 3 waiting for your approval.
 * - `retired`: replaced by another spec.
 * - `imported`: an import waiting for a person to confirm it.
 * - `approve-replaces`: the /approve page for a revision that replaces another
 *   spec, "Replaces <spec>. Retire it." above Approve.
 */
export const SPEC_PAGE_VARIANTS = ['approved', 'waiting', 'retired', 'imported', 'approve-replaces'] as const;
export type SpecPageVariant = (typeof SPEC_PAGE_VARIANTS)[number];

const SECTIONS: Array<[string, string[]]> = [
  ['Placing an order', [
    'A shopper places an order from a cart that holds at least one item. The order keeps the prices, tax and delivery the shopper saw on the pay screen, even when a price changes while they pay.',
    'Placing an order is one step for the shopper: they press Pay once, and the page says what happened in words before it moves on.',
  ]],
  ['Totals', [
    'The total is the sum of the items, the delivery charge and the tax, in the shopper\'s currency. Each part is shown on its own line above the total so the shopper can check it.',
    'Rounding follows the payment provider, so the amount charged is the amount shown, to the cent.',
  ]],
  ['Payment', [
    'Payment is taken once. A second press of Pay while the first is running does nothing, and a retry after a failure never charges twice.',
    'When the provider refuses a card the shopper sees the provider\'s reason in plain words and keeps the cart as it was.',
  ]],
  ['Delivery', [
    'Delivery options are offered for the shopper\'s address only. An address outside every delivery area says so before the pay screen, not after.',
    'The chosen delivery day appears on the receipt and in the confirmation email.',
  ]],
  ['Receipts', [
    'Every paid order has a receipt the shopper can open from the confirmation page and from their order list, without signing in again on the same device.',
    'A refund adds a line to the receipt with the amount and the date, and the original lines stay as they were.',
  ]],
  ['Cancelling', [
    'An order can be cancelled until it is packed. Cancelling refunds the full amount to the card that paid, and says how long the refund takes.',
    'After packing, the order page offers a return instead of a cancel, with the same words the returns page uses.',
  ]],
];

const section = ([title, paragraphs]: [string, string[]], i: number) => [
  `## ${i + 1}. ${title}`,
  '',
  ...paragraphs.flatMap((p) => [p, '']),
  `- R-${2 * i + 1}: ${paragraphs[0]!.split('. ')[0]}.`,
  `- R-${2 * i + 2}: ${paragraphs[1]!.split('. ')[0]}.`,
  `- AC-${i + 1}: GIVEN a cart with three items, WHEN the shopper reaches part ${i + 1}, THEN it reads as written above and nothing on the page needs a second look.`,
  '',
].join('\n');

export const SPEC_PAGE_FIXTURE_BODY = [
  '# Checkout',
  '',
  'How a cart becomes a paid order, a receipt and, sometimes, a refund. This spec is what the checkout team builds to and what review checks the work against.',
  '',
  'It covers the shopper\'s side only. The warehouse and the payment provider have their own specs, linked under Related.',
  '',
  SECTIONS.map(section).join('\n'),
  '## Out of scope',
  '',
  'Gift cards, split payments and orders placed by phone. Each has its own spec, and this one ends where they begin.',
].join('\n');

const at = '2026-10-15T12:00:00.000Z';
const APPROVED: Extract<SpecPageView, { state: 'ok' }> = {
  state: 'ok',
  spec: { id: 'fixture-spec', title: 'Checkout', scope: 'feature', status: 'approved', workspaceId: 'fixture-workspace', workspaceName: 'Shop', version: 3, headRevision: 2, approvedRevision: 2 },
  standing: 'approved at revision 2',
  reading: { revision: 2, approved: true, isHead: true },
  waiting: null,
  body: SPEC_PAGE_FIXTURE_BODY,
  revisions: [
    { revision: 2, author: 'person', changeSummary: 'Adds cancelling before packing.', approvedBy: 'Sam Rivera', approvedAt: at, createdAt: at, createdAgo: '3d ago', approvedAgo: '2d ago' },
    { revision: 1, author: 'agent', changeSummary: 'First draft.', approvedBy: 'Sam Rivera', approvedAt: at, createdAt: at, createdAgo: '9d ago', approvedAgo: '8d ago' },
  ],
  parent: { id: 'fixture-area', title: 'Buying' }, children: [], siblings: [{ id: 'fixture-sibling', title: 'Returns' }], repoRefs: [], nearby: [], filing: null,
  comments: [], commentAnchors: [], canComment: true, design: null, compare: null, canApprove: true, review: null,
  attachments: [], attachmentSources: {},
  canRetire: true, retireTargets: [{ id: 'fixture-sibling', title: 'Returns' }],
};

/** The /approve page for revision 3, which replaces another live spec (R-77). */
export const SPEC_PAGE_APPROVAL_VIEW: Extract<ApprovalRequestView, { state: 'ready' }> = {
  state: 'ready',
  title: 'Checkout',
  revision: 3,
  replaces: 2,
  sections: [{ kind: 'changed', path: 'Checkout > 6. Cancelling', level: 2, linesAdded: 2, linesRemoved: 1 }],
  hunks: [{ kind: 'changed', path: 'Checkout > 6. Cancelling', linesAdded: 2, linesRemoved: 1, rows: [
    { op: '-', oldLine: 60, newLine: null, text: 'An order can be cancelled until it is packed.' },
    { op: '+', oldLine: null, newLine: 60, text: 'An order can be cancelled until it is packed, from the order page or the confirmation email.' },
    { op: '+', oldLine: null, newLine: 61, text: '' },
  ] }],
  omittedLines: 0,
  body: SPEC_PAGE_FIXTURE_BODY,
  replacing: [
    { id: 'fixture-old-cancel', title: 'Order cancellation (2025)', version: 4, checked: true },
    { id: 'fixture-old-refunds', title: 'Refunds to the original card, before and after packing', version: 2, checked: true },
  ],
  gate: { passed: true, refusals: [], warnings: [] },
  changes: {
    summary: 'Cancelling works from the email too; folds in the two older cancellation specs.', mismatch: null, otherText: [],
    lines: [{ kind: 'added', id: 'R-13', text: 'An order can be cancelled from the confirmation email until it is packed.', section: '6. Cancelling' }],
  },
};

export function specPageFixtureView(v: Exclude<SpecPageVariant, 'approve-replaces'>): Extract<SpecPageView, { state: 'ok' }> {
  if (v === 'waiting') {
    return {
      ...APPROVED, spec: { ...APPROVED.spec, headRevision: 3, version: 4 }, waiting: 3,
      replacesSpecs: SPEC_PAGE_APPROVAL_VIEW.replacing.map(({ id, title }) => ({ id, title })),
      revisions: [
        { revision: 3, author: 'agent', changeSummary: SPEC_PAGE_APPROVAL_VIEW.changes!.summary, approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '1h ago', approvedAgo: null },
        ...APPROVED.revisions,
      ],
    };
  }
  if (v === 'retired') {
    return {
      ...APPROVED, spec: { ...APPROVED.spec, status: 'superseded' }, canApprove: false, retireTargets: [],
      retirement: { status: 'superseded', reason: 'Folded into Buying', supersededBy: { id: 'fixture-sibling', title: 'Buying: checkout and returns' }, by: 'user:fixture', at, repoFile: null, repoLine: null },
    };
  }
  if (v === 'imported') {
    return {
      ...APPROVED, spec: { ...APPROVED.spec, status: 'draft', approvedRevision: null, headRevision: 1, version: 1 },
      standing: 'imported, awaiting confirmation', reading: { revision: 1, approved: false, isHead: true }, canApprove: false, canRetire: false,
      revisions: [{ revision: 1, author: 'agent', changeSummary: 'Imported from docs/specs/checkout.md@87ee184 (last changed in #12)', approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '2h ago', approvedAgo: null }],
      source: { source: 'Imported from docs/specs/checkout.md@87ee184', copy: null, behind: false },
      importConfirmation: { revision: 1, path: 'docs/specs/checkout.md', commit: '87ee184', href: null, canConfirm: true, batchHref: '/app/dev/fixtures?state=spec-index', previous: null },
    };
  }
  return APPROVED;
}

export const parseSpecPageVariant = (raw: string | null): SpecPageVariant =>
  (SPEC_PAGE_VARIANTS as readonly string[]).includes(raw ?? '') ? raw as SpecPageVariant : 'approved';

export default function SpecPageFixture() {
  const [variant, setVariant] = useState<SpecPageVariant>('approved');
  useEffect(() => {
    setVariant(parseSpecPageVariant(new URLSearchParams(window.location.search).get('v')));
  }, []);
  if (variant === 'approve-replaces') {
    // The /approve page's own wrapper (specs/[specId]/approve/page.tsx).
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 md:py-10" data-testid="spec-page-fixture" data-variant={variant}>
        <SpecApprovalRequest specId="fixture-spec" token="fixture-token" view={SPEC_PAGE_APPROVAL_VIEW} />
      </main>
    );
  }
  // The spec route's own wrapper (specs/[specId]/page.tsx).
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10" data-testid="spec-page-fixture" data-variant={variant}>
      <SpecPage key={variant} view={specPageFixtureView(variant)} />
    </div>
  );
}
