'use client';

import { useState, type ReactNode } from 'react';
import Notice from '@/components/ui/Notice';
import type { ChangeLine, CriterionChange, SectionTextChange, WordOp } from '@buildd/spec-contract/criterion-review';

const KIND: Record<ChangeLine['kind'], string> = {
  added: 'Added', 'added-range': 'Added', changed: 'Changed', removed: 'Removed', moved: 'Moved', replacing: 'Replacing',
};
const OTHER: Record<SectionTextChange['kind'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const PREAMBLE = 'Before the first heading';

/** A heading path as the reader knows it: its last heading, the parents muted before it. */
function Heading({ path }: { path: string }) {
  if (!path) return <span>{PREAMBLE}</span>;
  const parts = path.split(' > ');
  const last = parts.pop()!;
  return (
    <span>
      {parts.length ? <span className="text-text-muted">{parts.join(' › ')} › </span> : null}
      {last}
    </span>
  );
}

/** Changed words marked: removed struck on red, added on green; the rest as written. */
export function MarkedWords({ words }: { words: WordOp[] }) {
  return (
    <>
      {words.map((w, i) => (w.op === '+'
        ? <ins key={i} className="bg-[var(--ok-tint)] text-text-primary no-underline" data-testid="spec-review-word-added">{w.text}</ins>
        : w.op === '-'
          ? <del key={i} className="bg-[var(--bad-tint)] text-text-secondary" data-testid="spec-review-word-removed">{w.text}</del>
          : <span key={i}>{w.text}</span>))}
    </>
  );
}

const Words = ({ text }: { text: string }) => <span className="whitespace-pre-line">{text}</span>;

function Row({ kind, label, children }: { kind: string; label: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 md:grid md:grid-cols-[5.5rem_6.5rem_minmax(0,1fr)] md:gap-3" data-testid="spec-review-change" data-kind={kind}>
      {/* One line on a phone (kind, id), two columns from md. */}
      <div className="flex items-baseline gap-2 md:contents">
        <span className="text-meta text-text-muted">{KIND[kind as ChangeLine['kind']] ?? kind}</span>
        <span className="font-mono text-meta font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-review-change-id">{label}</span>
      </div>
      <div className="min-w-0 text-body text-text-primary [overflow-wrap:anywhere]">{children}</div>
    </li>
  );
}

function ChangeRow({ c }: { c: CriterionChange }) {
  switch (c.kind) {
    case 'added':
      return <Row kind="added" label={c.id}><Words text={c.text} /></Row>;
    case 'changed':
      return (
        <Row kind="changed" label={c.id}>
          <span className="whitespace-pre-line"><MarkedWords words={c.words} /></span>
          {c.movedFrom !== undefined ? <p className="text-meta text-text-muted">Moved here from <Heading path={c.movedFrom} />.</p> : null}
        </Row>
      );
    case 'moved':
      return (
        <Row kind="moved" label={c.id}>
          <p className="text-meta text-text-secondary">From <Heading path={c.movedFrom} /> to <Heading path={c.section} />. Same words.</p>
        </Row>
      );
    case 'removed':
      return <Row kind="removed" label={c.id}><del className="whitespace-pre-line text-text-secondary">{c.oldText}</del></Row>;
    case 'replacing':
      return (
        <Row kind="replacing" label={c.id}>
          <p className="text-meta text-text-secondary">Replaces {c.replaces.map((r) => r.id).join(', ')}.</p>
          <Words text={c.text} />
        </Row>
      );
  }
}

function AddedRange({ line }: { line: Extract<ChangeLine, { kind: 'added-range' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-0.5 py-2 md:grid md:grid-cols-[5.5rem_minmax(0,1fr)] md:gap-3" data-testid="spec-review-change" data-kind="added-range">
      <div className="flex min-w-0 items-baseline gap-2 md:contents">
      <span className="text-meta text-text-muted">Added</span>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-11 items-center gap-2 text-left font-mono text-meta font-semibold text-text-primary underline md:min-h-0"
          data-testid="spec-review-range"
        >
          {line.label}
          <span aria-hidden className={`inline-block font-sans text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        </button>
        {open ? (
          <ul className="mt-1 flex flex-col divide-y divide-[var(--line-soft)]">
            {line.items.map((c) => (
              <li key={c.id} className="flex flex-col gap-0.5 py-1.5 md:flex-row md:gap-3" data-testid="spec-review-range-item">
                <span className="w-24 shrink-0 font-mono text-meta font-semibold text-text-primary">{c.id}</span>
                <span className="min-w-0 text-body text-text-primary [overflow-wrap:anywhere]"><Words text={c.text} /></span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      </div>
    </li>
  );
}

/** The other-text changes grouped by kind, in the order each kind first appears, sections in their order. */
export function otherByKind(otherText: SectionTextChange[]): Array<[SectionTextChange['kind'], string[]]> {
  const by = new Map<SectionTextChange['kind'], string[]>();
  for (const o of otherText) by.set(o.kind, [...(by.get(o.kind) ?? []), o.section]);
  return [...by];
}

export interface SpecReviewChangesProps {
  summary: string | null;
  lines: ChangeLine[];
  otherText: SectionTextChange[];
  mismatch: string | null;
}

/**
 * What a revision changes, the way Review leads ("Reviewing a spec revision"
 * R-1 to R-5): the author's change summary, the one-line summary check, every
 * criterion added, changed, removed, moved or replacing by id (changed words
 * marked, added runs folded into one range), then the other text by section
 * heading. All of it computed; nothing here is written by a model (R-6).
 */
export default function SpecReviewChanges({ summary, lines, otherText, mismatch }: SpecReviewChangesProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="spec-review-changes">
      {summary?.trim()
        ? <p className="whitespace-pre-line text-lede text-text-primary [overflow-wrap:anywhere]" data-testid="spec-review-summary">{summary.trim()}</p>
        : <p className="text-body text-text-muted" data-testid="spec-review-summary">No change summary.</p>}
      {mismatch ? <Notice tone="warn" data-testid="spec-review-mismatch">{mismatch}</Notice> : null}
      <section aria-labelledby="spec-review-criteria-heading">
        <h3 id="spec-review-criteria-heading" className="text-meta font-semibold text-text-secondary">Requirements and acceptance</h3>
        {lines.length ? (
          <ul className="mt-1 flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-review-criteria">
            {lines.map((l, i) => (l.kind === 'added-range' ? <AddedRange key={`r${i}`} line={l} /> : <ChangeRow key={`${l.kind}:${l.id}`} c={l} />))}
          </ul>
        ) : <p className="mt-1 text-body text-text-secondary">No criterion changed.</p>}
      </section>
      <section aria-labelledby="spec-review-other-heading">
        <h3 id="spec-review-other-heading" className="text-meta font-semibold text-text-secondary">Other text</h3>
        {otherText.length ? (
          <ul className="mt-1 flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-review-other">
            {/* One row per kind, its sections under it: twelve added sections are one "Added", not twelve. */}
            {otherByKind(otherText).map(([kind, sections]) => (
              <li key={kind} className="flex flex-col gap-0.5 py-2 md:grid md:grid-cols-[5.5rem_minmax(0,1fr)] md:gap-3" data-testid="spec-review-other-row" data-kind={kind}>
                <span className="text-meta text-text-muted">{OTHER[kind]}</span>
                <ul className="flex min-w-0 flex-col gap-0.5">
                  {sections.map((section) => (
                    <li key={section} className="text-body text-text-primary [overflow-wrap:anywhere]"><Heading path={section} /></li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-body text-text-secondary">No other text changed.</p>}
      </section>
    </div>
  );
}
