'use client';

import { useEffect, useState } from 'react';
import SpecPage from '@/components/SpecPage';
import type { SpecPageView } from '@/lib/specs/page-view';

/**
 * A spec page's decision, for Visual QA at 320 and 390 wide (living-specs.md
 * §18, R-19): `?state=spec-import-review&v=` one of
 * - `imported` (default): an unconfirmed re-import of a 12-section repo file;
 *   Confirm import is the one action, docked at the bottom.
 * - `first`: a never-approved first revision under review: the rendered spec,
 *   not a diff against nothing.
 * - `amended`: a confirmed baseline with a proposed change under review: the
 *   change list against it, the line diff behind a toggle.
 * - `approved`: an approved spec with nothing waiting, whose text is titled
 *   differently, with work against it and its repo file: the desktop rail.
 * - `compare`: the same spec opened on History with revisions 2 and 3 picked
 *   and their diff above the rows.
 */
export const SPEC_IMPORT_REVIEW_VARIANTS = ['imported', 'first', 'amended', 'approved', 'compare'] as const;
type Variant = (typeof SPEC_IMPORT_REVIEW_VARIANTS)[number];

const SECTIONS = Array.from({ length: 12 }, (_, i) => [
  `## ${i + 1}. Part ${i + 1}`,
  '',
  `- R-${i + 1}: Part ${i + 1} MUST hold for every row, and the row MUST say so in one line.`,
  `- AC-${i + 1}: GIVEN a mission with seven tasks, WHEN part ${i + 1} renders, THEN it holds.`,
  '',
].join('\n')).join('\n');
const BODY = `# Mission Flow Timeline\n\nThe Flow tab renders every deliverable task as one row on one shared time axis.\n\n${SECTIONS}`;

const at = '2026-10-15T12:00:00.000Z';
const BASE: Extract<SpecPageView, { state: 'ok' }> = {
  state: 'ok',
  spec: { id: 'fixture-spec', title: 'Mission Flow Timeline', scope: 'feature', status: 'draft', workspaceId: 'fixture-workspace', workspaceName: 'Shop', version: 2, headRevision: 2, approvedRevision: null },
  standing: 'imported, awaiting confirmation',
  reading: { revision: 2, approved: false, isHead: true },
  waiting: null,
  body: BODY,
  revisions: [
    { revision: 2, author: 'agent', changeSummary: 'Imported from docs/specs/mission-flow-timeline.md@87ee184 (last changed in #12)', approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '2d ago', approvedAgo: null },
    { revision: 1, author: 'agent', changeSummary: 'Imported from docs/specs/mission-flow-timeline.md@429e8f4 (last changed in #11)', approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '4d ago', approvedAgo: null },
  ],
  parent: { id: 'fixture-area', title: 'Tasks and missions' }, children: [], siblings: [], repoRefs: [], nearby: [], filing: null,
  comments: [], commentAnchors: [], canComment: true, design: null, compare: null, canApprove: false, review: null,
  attachments: [], attachmentSources: {},
  source: { source: 'Imported from docs/specs/mission-flow-timeline.md@87ee184', copy: null, behind: false },
  importConfirmation: { revision: 2, path: 'docs/specs/mission-flow-timeline.md', commit: '87ee184', href: null, canConfirm: true, batchHref: '/app/dev/fixtures?state=spec-index', previous: 1 },
};

const FIRST_REVIEW = {
  replaces: null, revision: 1, omittedLines: 0, sectionCount: 13, linesAdded: 192, linesRemoved: 0, body: BODY,
  hunks: [{ kind: 'added' as const, path: 'Mission Flow Timeline', linesAdded: 192, linesRemoved: 0, rows: [] }],
  changes: { summary: 'First draft of the Flow tab.', mismatch: null, otherText: [], lines: [] },
};

const AMENDED_REVIEW = {
  replaces: 2, revision: 3, omittedLines: 0, sectionCount: 1, linesAdded: 3, linesRemoved: 1, body: BODY,
  hunks: [{ kind: 'changed' as const, path: 'Mission Flow Timeline > 3. Part 3', linesAdded: 3, linesRemoved: 1, rows: [
    { op: '-' as const, oldLine: 30, newLine: null, text: '- R-11: The selected task\'s card sits below the timeline on a phone.' },
    { op: '+' as const, oldLine: null, newLine: 30, text: '- R-11: Tapping a task on a phone opens its detail in a bottom sheet at once.' },
    { op: '+' as const, oldLine: null, newLine: 31, text: '- R-20: Closing the sheet keeps the timeline where it was.' },
    { op: '+' as const, oldLine: null, newLine: 32, text: '' },
  ] }],
  changes: {
    summary: 'R-11: a tapped task opens in a bottom sheet on a phone; adds R-20.', mismatch: null,
    lines: [
      { kind: 'changed' as const, id: 'R-11', text: 'Tapping a task on a phone opens its detail in a bottom sheet at once.', oldText: 'The selected task\'s card sits below the timeline on a phone.', section: '3. Part 3', words: [{ op: '-' as const, text: 'The selected task\'s card sits below the timeline' }, { op: '+' as const, text: 'Tapping a task' }, { op: '=' as const, text: ' on a phone' }, { op: '+' as const, text: ' opens its detail in a bottom sheet at once' }, { op: '=' as const, text: '.' }] },
      { kind: 'added' as const, id: 'R-20', text: 'Closing the sheet keeps the timeline where it was.', section: '3. Part 3' },
    ],
    otherText: [],
  },
};

function viewOf(v: Variant): Extract<SpecPageView, { state: 'ok' }> {
  if (v === 'compare') {
    const amended = viewOf('amended');
    return { ...amended, review: null, canApprove: false, compare: { ...AMENDED_REVIEW, from: 2, to: 3 } };
  }
  if (v === 'approved') {
    return {
      ...BASE, spec: { ...BASE.spec, status: 'approved', approvedRevision: 2 }, standing: 'approved at revision 2', reading: { revision: 2, approved: true, isHead: true },
      body: BODY.replace('# Mission Flow Timeline', '# Mission Flow Timeline (Flow tab, rows and the shared axis)'),
      importConfirmation: null, canRetire: true, retireTargets: [],
      source: { source: null, path: 'docs/specs/mission-flow-timeline.md', href: 'https://github.com/acme/shop/blob/main/docs/specs/mission-flow-timeline.md', copy: null, behind: false },
      revisions: [{ ...BASE.revisions[0]!, approvedBy: 'Sam Rivera', approvedAt: at, approvedAgo: '1d ago' }, BASE.revisions[1]!],
      delivery: { next: null, entries: [{
        kind: 'task', id: 'fixture-task', title: 'Draw every deliverable on one axis', href: '/app/dev/fixtures?state=task-page', builtTo: 2, provisional: false, delivered: true,
        deliveredText: 'Built to revision 2. Merged.', standing: { tone: 'success', text: 'Verified against revision 2.' },
        criteria: [{ criterionId: 'R-1', text: 'Part 1 holds.', mark: 'pass', evidence: [] }], links: [], at,
      }] },
    };
  }
  if (v === 'first') {
    return {
      ...BASE, spec: { ...BASE.spec, headRevision: 1, version: 1 }, standing: 'draft, never approved', reading: { revision: 1, approved: false, isHead: true },
      waiting: 1, canApprove: true, review: FIRST_REVIEW, revisions: [{ ...BASE.revisions[1]!, changeSummary: 'First draft of the Flow tab.', author: 'person' }],
      source: null, importConfirmation: null, body: '',
    };
  }
  if (v === 'amended') {
    return {
      ...BASE, spec: { ...BASE.spec, headRevision: 3, approvedRevision: 2, version: 4 }, standing: 'approved at revision 2', reading: { revision: 2, approved: true, isHead: false },
      waiting: 3, canApprove: true, review: AMENDED_REVIEW, source: null, importConfirmation: null, body: '',
      revisions: [
        { revision: 3, author: 'person', changeSummary: AMENDED_REVIEW.changes.summary, approvedBy: null, approvedAt: null, createdAt: at, createdAgo: '1h ago', approvedAgo: null },
        { ...BASE.revisions[0]!, approvedBy: 'Sam Rivera', approvedAt: at, approvedAgo: '1d ago' },
        BASE.revisions[1]!,
      ],
    };
  }
  return BASE;
}

export default function SpecImportReviewFixture() {
  const [variant, setVariant] = useState<Variant>('imported');
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('v');
    if ((SPEC_IMPORT_REVIEW_VARIANTS as readonly string[]).includes(v ?? '')) setVariant(v as Variant);
  }, []);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10" data-testid="spec-import-review-fixture" data-variant={variant}>
      <SpecPage key={variant} view={viewOf(variant)} />
    </div>
  );
}
