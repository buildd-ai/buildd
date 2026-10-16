'use client';

import SpecPage from '@/components/SpecPage';
import SpecRevisionPanes from '@/components/SpecRevisionPanes';
import type { SpecPageView } from '@/lib/specs/page-view';

/**
 * A spec page with attachments (living-specs.md §21), for Visual QA at phone
 * width: an inline binding image, a reference missing from the revision
 * (shown as missing), and the Files section with a binding attachment that
 * changed since approval and a reference one. Then the approval page's
 * rendered pane with the same body. The images are inline SVG so nothing is
 * fetched; on a real page they come from the spec's attachment link.
 */

const svg = (label: string, fill: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="${fill}"/><rect x="40" y="40" width="560" height="56" rx="6" fill="#ffffff" opacity="0.8"/><rect x="40" y="128" width="360" height="24" rx="4" fill="#ffffff" opacity="0.6"/><rect x="40" y="168" width="420" height="24" rx="4" fill="#ffffff" opacity="0.6"/><rect x="40" y="300" width="200" height="56" rx="6" fill="#d97706"/><text x="320" y="78" font-family="sans-serif" font-size="24" text-anchor="middle" fill="#1f2937">${label}</text></svg>`,
)}`;

const PAY = svg('Pay screen', '#e5e7eb');
const RECEIPT = svg('Receipt', '#dbeafe');

export const SPEC_ATTACHMENTS_FIXTURE_BODY = [
  '# Checkout',
  '',
  'How a paid cart becomes a receipt.',
  '',
  '![The pay screen, with the total above the Pay button](attachment:pay-screen)',
  '',
  '- **AC-1** Paying shows the receipt.',
  '',
  '![The receipt](attachment:receipt)',
  '',
  '- **AC-2** A refund shows a note on the receipt.',
  '',
  '![Refund note](attachment:refund-note)',
].join('\n');

const SOURCES = {
  'pay-screen': { src: PAY, alt: 'The pay screen', image: true },
  receipt: { src: RECEIPT, alt: null, image: true },
};

const at = '2026-10-10T12:00:00.000Z';
const VIEW: Extract<SpecPageView, { state: 'ok' }> = {
  state: 'ok',
  spec: { id: 'fixture-spec', title: 'Checkout', scope: 'feature', status: 'approved', workspaceId: 'fixture-workspace', workspaceName: 'Shop', version: 4, headRevision: 2, approvedRevision: 2 },
  standing: 'approved at revision 2',
  reading: { revision: 2, approved: true, isHead: true },
  waiting: null,
  body: SPEC_ATTACHMENTS_FIXTURE_BODY,
  revisions: [
    { revision: 2, author: 'agent', changeSummary: 'Adds the receipt.', approvedBy: 'Sam Rivera', approvedAt: at, createdAt: at, createdAgo: '3d ago', approvedAgo: '3d ago' },
    { revision: 1, author: 'person', changeSummary: null, approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '4d ago', approvedAgo: null },
  ],
  parent: null, children: [], siblings: [], repoRefs: [], nearby: [], filing: null,
  comments: [], commentAnchors: [], canComment: true, design: null, compare: null, canApprove: false, review: null,
  attachmentSources: SOURCES,
  attachments: [
    {
      id: 'a1', name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: 'art-1', title: 'Pay screen', mimeType: 'image/png', isImage: true,
      artifactRevision: 3, addedInRevision: 1, removedFromRevision: null, addedBy: { kind: 'person', name: 'Sam Rivera' }, addedAt: at, addedAgo: '4d ago',
      url: PAY, approval: { state: 'changed', pinned: 2, current: 3 },
    },
    {
      id: 'a2', name: 'receipt', kind: 'binding', caption: null, artifactId: 'art-2', title: 'Receipt', mimeType: 'image/png', isImage: true,
      artifactRevision: 1, addedInRevision: 2, removedFromRevision: null, addedBy: { kind: 'agent', name: null }, addedAt: at, addedAgo: '3d ago',
      url: RECEIPT, approval: { state: 'unchanged', pinned: 1, current: 1 },
    },
    {
      id: 'a3', name: 'interview-notes-with-a-long-name-for-wrapping', kind: 'reference', caption: 'What five shoppers said about refunds, in their words', artifactId: 'art-3', title: 'Notes', mimeType: 'text/markdown', isImage: false,
      artifactRevision: 4, addedInRevision: 2, removedFromRevision: null, addedBy: { kind: 'agent', name: null }, addedAt: at, addedAgo: '2d ago',
      url: '#', approval: null,
    },
  ],
};

export default function SpecAttachmentsFixture() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10" data-testid="spec-attachments-fixture">
      <SpecPage view={VIEW} />
      <section className="flex flex-col gap-3" data-testid="spec-attachments-fixture-approval">
        <h2 className="section-label text-text-muted">Approval page</h2>
        <SpecRevisionPanes body={SPEC_ATTACHMENTS_FIXTURE_BODY} hunks={[]} omittedLines={0} sectionCount={1} linesAdded={13} linesRemoved={0} initial="spec" attachments={SOURCES} />
      </section>
    </main>
  );
}
