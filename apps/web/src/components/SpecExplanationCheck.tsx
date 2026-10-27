'use client';

import type { ReactNode } from 'react';
import { ChangedText, CriterionChangeWords, Heading, Words } from '@/components/SpecReviewChanges';
import type { CoverageItem, ExplanationCoverage, SpecExplanation } from '@buildd/spec-contract/explanation';
import type { WordOp } from '@buildd/spec-contract/criterion-review';

const CHANGE: Record<CoverageItem['change'], string> = {
  added: 'Added', changed: 'Changed', removed: 'Removed', replacing: 'Replacing',
};

/** What the check proves (R-18), said every time the check is shown. */
export const COVERAGE_HONESTY = 'The agent wrote this explanation. The check confirms it mentions every change; whether it is right is yours to judge.';

/** A section's changed words: added text plain, removed struck, a change with its words marked. */
function SectionWords({ item, words }: { item: Extract<CoverageItem, { kind: 'section' }>; words: WordOp[] | undefined }) {
  if (!words?.length) return <p className="text-meta text-text-muted">No text to show.</p>;
  if (item.change === 'added') return <Words text={words.filter((w) => w.op !== '-').map((w) => w.text).join('')} />;
  if (item.change === 'removed') return <del className="whitespace-pre-line text-text-secondary">{words.filter((w) => w.op !== '+').map((w) => w.text).join('')}</del>;
  return <ChangedText words={words} />;
}

function Label({ item }: { item: CoverageItem }) {
  return item.kind === 'criterion'
    ? <span className="font-mono font-semibold text-text-primary">{item.key}</span>
    : <span className="font-semibold text-text-primary"><Heading path={item.key} /></span>;
}

/**
 * One change as a line that opens in place (R-17): its id or heading, the
 * explanation (or "Not explained"), and, open, the exact changed words. The
 * button is the whole line, 44px tall on a phone.
 */
function ItemLine({ item, open, onToggle, sectionWords }: { item: CoverageItem; open: boolean; onToggle: () => void; sectionWords: Record<string, WordOp[]> }) {
  const panel = `spec-explain-${item.kind}-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <li className="py-1" data-testid="spec-explain-item" data-key={item.key} data-explained={item.explanation !== null ? 'yes' : 'no'} data-open={open ? 'yes' : 'no'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className="flex min-h-11 w-full items-start gap-2 py-1.5 text-left text-body md:min-h-0"
        data-testid="spec-explain-toggle"
      >
        <span aria-hidden className={`mt-0.5 inline-block text-meta leading-none text-text-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
          <span className="flex flex-wrap items-baseline gap-x-2 text-meta">
            <span className="text-text-muted">{CHANGE[item.change]}</span>
            <Label item={item} />
          </span>
          {item.explanation !== null
            ? <span className="text-text-primary" data-testid="spec-explain-text">{item.explanation}</span>
            : <span className="text-text-secondary" data-testid="spec-explain-text">Not explained. Open it to read the change.</span>}
        </span>
      </button>
      {open ? (
        <div id={panel} className="mb-2 ml-5 border-l-2 border-[var(--line-soft)] pl-3 text-body text-text-primary [overflow-wrap:anywhere]" data-testid="spec-explain-words">
          {item.kind === 'criterion' ? <CriterionChangeWords c={item.criterion} /> : <SectionWords item={item} words={sectionWords[item.key]} />}
        </div>
      ) : null}
    </li>
  );
}

function Group({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col" data-testid={testid}>
      <h3 className="text-meta font-semibold text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The top of one approval decision (Living Spec b7fc9316 R-14 to R-19): the
 * author's one-line summary, the mechanical coverage result, then each change
 * as a line that opens to its exact words. Changes the explanation does not
 * cover are listed under Not explained; lines that explain something the
 * revision does not change are listed apart. Nothing here is written by a
 * model when the page loads.
 */
export default function SpecExplanationCheck({ explanation, coverage, sectionWords, opened, onToggle }: {
  explanation: SpecExplanation | null;
  coverage: ExplanationCoverage;
  sectionWords: Record<string, WordOp[]>;
  opened: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const explained = coverage.items.filter((i) => i.explanation !== null);
  const line = (i: CoverageItem) => (
    <ItemLine key={`${i.kind}:${i.key}`} item={i} open={opened.has(i.key)} onToggle={() => onToggle(i.key)} sectionWords={sectionWords} />
  );
  return (
    <section aria-label="What this revision changes" className="flex flex-col gap-3" data-testid="spec-explain">
      {explanation
        ? <p className="text-lede text-text-primary [overflow-wrap:anywhere]" data-testid="spec-explain-summary">{explanation.summary}</p>
        : <p className="text-body text-text-secondary" data-testid="spec-explain-summary">The author gave no explanation. Open each change to read it.</p>}
      <div className="flex flex-col gap-1">
        <p className={`text-body font-semibold ${coverage.passed ? 'text-status-success' : 'text-status-warning'}`} data-testid="spec-explain-coverage" data-passed={coverage.passed ? 'yes' : 'no'}>
          {coverage.line}
        </p>
        {coverage.total > 0 ? <p className="text-meta text-text-muted" data-testid="spec-explain-honesty">{COVERAGE_HONESTY}</p> : null}
      </div>
      {coverage.notExplained.length ? (
        <Group title={`Not explained (${coverage.notExplained.length})`} testid="spec-explain-missing">
          <ul className="flex flex-col divide-y divide-[var(--line-soft)]">{coverage.notExplained.map(line)}</ul>
        </Group>
      ) : null}
      {explained.length ? (
        <Group title="Explained" testid="spec-explain-covered">
          <ul className="flex flex-col divide-y divide-[var(--line-soft)]">{explained.map(line)}</ul>
        </Group>
      ) : null}
      {coverage.extra.length ? (
        <Group title="Explains something that did not change" testid="spec-explain-extra">
          <ul className="flex flex-col divide-y divide-[var(--line-soft)]">
            {coverage.extra.map((x) => (
              <li key={x.key} className="flex flex-col gap-0.5 py-2 [overflow-wrap:anywhere]" data-testid="spec-explain-extra-item" data-key={x.key}>
                <span className="font-mono text-meta font-semibold text-text-primary">{x.key}</span>
                <span className="text-body text-text-secondary">{x.text}</span>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
    </section>
  );
}
