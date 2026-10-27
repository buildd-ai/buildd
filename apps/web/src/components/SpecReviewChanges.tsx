'use client';

import { useState, type ReactNode } from 'react';
import Notice from '@/components/ui/Notice';
import { mostlyRewritten } from '@buildd/spec-contract/criterion-review';
import type { ChangeLine, CriterionChange, SectionTextChange, WordOp } from '@buildd/spec-contract/criterion-review';

const KIND: Record<ChangeLine['kind'], string> = {
  added: 'Added', 'added-range': 'Added', changed: 'Changed', removed: 'Removed', moved: 'Moved', replacing: 'Replacing',
};
const OTHER: Record<SectionTextChange['kind'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const PREAMBLE = 'Before the first heading';

/** A heading path as the reader knows it: its last heading, the parents muted before it. */
export function Heading({ path }: { path: string }) {
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

/** Open inline code / emphasis, carried across the runs of one text so a span may straddle a mark. */
interface InlineState { code: boolean; strong: boolean; em: boolean }
const freshInline = (): InlineState => ({ code: false, strong: false, em: false });

/**
 * A run of criterion text with its inline markdown shown (R-19): `code` as code,
 * **strong** and *emphasis* as such, never a backtick or asterisk. Only these
 * three; the markers are consumed and the state passes to the next run.
 */
function Inline({ text, state }: { text: string; state: InlineState }) {
  const parts: ReactNode[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const k = parts.length;
    let node: ReactNode = buf;
    if (state.code) node = <code key={k} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]">{buf}</code>;
    else {
      if (state.em) node = <em>{node}</em>;
      if (state.strong) node = <strong className="font-semibold">{node}</strong>;
      node = <span key={k}>{node}</span>;
    }
    parts.push(node);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '`') { flush(); state.code = !state.code; continue; }
    if (!state.code && ch === '*') {
      flush();
      if (text[i + 1] === '*') { state.strong = !state.strong; i++; } else state.em = !state.em;
      continue;
    }
    buf += ch;
  }
  flush();
  return <>{parts}</>;
}

/** Changed words marked: removed struck on red, added on green; the rest as written. */
export function MarkedWords({ words }: { words: WordOp[] }) {
  const state = freshInline();
  return (
    <>
      {words.map((w, i) => (w.op === '+'
        ? <ins key={i} className="bg-[var(--ok-tint)] text-text-primary no-underline" data-testid="spec-review-word-added"><Inline text={w.text} state={state} /></ins>
        : w.op === '-'
          ? <del key={i} className="bg-[var(--bad-tint)] text-text-secondary" data-testid="spec-review-word-removed"><Inline text={w.text} state={state} /></del>
          : <span key={i}><Inline text={w.text} state={state} /></span>))}
    </>
  );
}

/**
 * A rewritten criterion as the old words and the new ones, each readable whole
 * (R-18): Was muted and not struck, Now with the added words highlighted.
 */
export function WasNow({ words }: { words: WordOp[] }) {
  const was = freshInline(); const now = freshInline();
  return (
    <div className="flex flex-col gap-1.5" data-testid="spec-review-was-now">
      <p className="text-text-secondary" data-testid="spec-review-was">
        <span className="mr-2 text-meta font-semibold text-text-muted">Was</span>
        {words.filter((w) => w.op !== '+').map((w, i) => <span key={i}><Inline text={w.text} state={was} /></span>)}
      </p>
      <p className="text-text-primary" data-testid="spec-review-now">
        <span className="mr-2 text-meta font-semibold text-text-muted">Now</span>
        {words.filter((w) => w.op !== '-').map((w, i) => (w.op === '+'
          ? <ins key={i} className="bg-[var(--ok-tint)] no-underline" data-testid="spec-review-word-added"><Inline text={w.text} state={now} /></ins>
          : <span key={i}><Inline text={w.text} state={now} /></span>))}
      </p>
    </div>
  );
}

/** A criterion's changed words: inline marks, or Was and Now when most of it changed. */
export function ChangedText({ words }: { words: WordOp[] }) {
  return mostlyRewritten(words)
    ? <WasNow words={words} />
    : <span className="whitespace-pre-line"><MarkedWords words={words} /></span>;
}

export const Words = ({ text }: { text: string }) => <span className="whitespace-pre-line"><Inline text={text} state={freshInline()} /></span>;

function Row({ kind, label, children }: { kind: string; label: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 md:grid md:grid-cols-[5rem_5rem_minmax(0,1fr)] md:gap-3" data-testid="spec-review-change" data-kind={kind}>
      {/* One line on a phone (kind, id), two columns from md. */}
      <div className="flex items-baseline gap-2 md:contents">
        <span className="text-meta text-text-muted">{KIND[kind as ChangeLine['kind']] ?? kind}</span>
        <span className="font-mono text-meta font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-review-change-id">{label}</span>
      </div>
      <div className="min-w-0 text-body text-text-primary [overflow-wrap:anywhere]">{children}</div>
    </li>
  );
}

/** A criterion change's words as Review shows them: added, changed (words marked), moved, removed or replacing. */
export function CriterionChangeWords({ c }: { c: CriterionChange }) {
  switch (c.kind) {
    case 'added':
      return <Words text={c.text} />;
    case 'changed':
      return (
        <>
          <ChangedText words={c.words} />
          {c.movedFrom !== undefined ? <p className="text-meta text-text-muted">Moved here from <Heading path={c.movedFrom} />.</p> : null}
        </>
      );
    case 'moved':
      return <p className="text-meta text-text-secondary">From <Heading path={c.movedFrom} /> to <Heading path={c.section} />. Same words.</p>;
    case 'removed':
      return <del className="whitespace-pre-line text-text-secondary"><Inline text={c.oldText} state={freshInline()} /></del>;
    case 'replacing':
      return (
        <>
          <p className="text-meta text-text-secondary">Replaces {c.replaces.map((r) => r.id).join(', ')}.</p>
          <Words text={c.text} />
        </>
      );
  }
}

function ChangeRow({ c }: { c: CriterionChange }) {
  return <Row kind={c.kind} label={c.id}><CriterionChangeWords c={c} /></Row>;
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
