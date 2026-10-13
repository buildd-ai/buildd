'use client';

import { useState } from 'react';
import Card from '@/components/ui/Card';
import Segmented from '@/components/ui/Segmented';
import MarkdownContent from '@/components/MarkdownContent';
import SpecDiffView from '@/components/SpecDiffView';
import type { DiffHunk } from '@/lib/specs/diff';

type Pane = 'spec' | 'changes';
const PANES = [{ value: 'spec', label: 'Spec' }, { value: 'changes', label: 'Changes' }] as const;

export interface SpecRevisionPanesProps {
  /** The revision's whole text, Markdown. */
  body: string;
  hunks: DiffHunk[];
  omittedLines: number;
  sectionCount: number;
  linesAdded: number;
  linesRemoved: number;
  /** Which view opens first: the spec when there is nothing to compare against, else the changes. */
  initial: Pane;
}

/**
 * One revision two ways: rendered as Markdown, or what it changes as a
 * numbered diff (SpecDiffView), with a Spec / Changes switch and the totals
 * beside it. Used by the approval confirm page and the spec page's review.
 */
export default function SpecRevisionPanes({ body, hunks, omittedLines, sectionCount, linesAdded, linesRemoved, initial }: SpecRevisionPanesProps) {
  const [pane, setPane] = useState<Pane>(initial);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented items={PANES} value={pane} onChange={setPane} label="Show" />
        <span className="font-mono text-meta text-text-muted" data-testid="spec-approval-sections">
          {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}
          {' · '}
          <span className="text-status-success">+{linesAdded}</span>{' '}
          <span className="text-status-error">−{linesRemoved}</span>
        </span>
      </div>
      {pane === 'spec' ? (
        <Card data-testid="spec-approval-rendered">
          <MarkdownContent content={body} images="link" surface="spec" />
        </Card>
      ) : (
        <SpecDiffView hunks={hunks} omittedLines={omittedLines} />
      )}
    </>
  );
}
