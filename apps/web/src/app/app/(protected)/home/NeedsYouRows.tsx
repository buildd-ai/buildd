'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { HomeAttentionItem } from '@/lib/home-needs-you';
import { actionNoun } from '@/lib/home-attention';
import { displayTaskTitle } from '@/lib/task-title';
import { decisionLine, MAX_ROWS, type NeedsYouRowEntry, type PolicyDigestEntry } from './needs-you-layout';

const action = 'inline-flex min-h-11 shrink-0 items-center text-body font-medium text-text-primary underline decoration-border-strong underline-offset-4 hover:decoration-text-primary md:min-h-0';

function Row({ item, line = true }: { item: HomeAttentionItem; line?: boolean }) {
  const go = item.primary ?? { label: 'Open', href: item.href };
  const sub = [item.meta, line ? decisionLine(item) : null].filter(Boolean).join(' · ');
  // Title, then one truncated line (where · why); the action stays at the right edge.
  return <li data-testid="needs-you-row" className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 border-b border-border-default py-2.5 last:border-b-0">
    <span className="min-w-0">
      <span className="line-clamp-2 text-title font-medium text-text-primary [overflow-wrap:anywhere]">{displayTaskTitle(item.title)}</span>
      {sub && <span className="block truncate text-meta text-text-secondary">{sub}</span>}
    </span>
    <Link href={go.href} className={action}>{go.label}</Link>
  </li>;
}

/**
 * The decisions after the first few cards: L1 hairline rows, one text action
 * each. Rows that ask the same thing are one row with the count; it opens to
 * the subjects. Past MAX_ROWS the rest wait behind "Show all".
 */
export function NeedsYouRows({ rows }: { rows: NeedsYouRowEntry[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, MAX_ROWS);
  return <div data-testid="needs-you-rows" className="mt-4">
    <ul className="border-t border-border-default">
      {shown.map(r => r.kind === 'single'
        ? <Row key={r.item.key} item={r.item} />
        : <li key={`g:${r.items[0].key}`} className="border-b border-border-default last:border-b-0">
          <details data-testid="needs-you-group">
            <summary className="flex min-h-11 cursor-pointer flex-wrap items-baseline gap-x-3 py-2.5 md:min-h-0">
              <span className="text-title font-medium text-text-primary">
                {r.items.length} {r.items.every(i => i.actionType === r.items[0].actionType) ? actionNoun(r.items[0].actionType, r.items.length) : 'items'}
              </span>
              <span className="min-w-0 flex-1 text-body text-text-secondary">{r.line}</span>
            </summary>
            <ul className="pb-1 pl-4">{r.items.map(i => <Row key={i.key} item={i} line={false} />)}</ul>
          </details>
        </li>)}
    </ul>
    {rows.length > shown.length && <button type="button" onClick={() => setAll(true)} className={`${action} mt-2`}>Show all {rows.length}</button>}
  </div>;
}

/**
 * One line per kind of policy decision. Each opens to its subjects, and each
 * subject keeps its own action: a digest never approves anything in bulk.
 */
export function PolicyDigests({ digests }: { digests: PolicyDigestEntry[] }) {
  return <ul data-testid="policy-digests" className="mt-4 border-t border-border-default">
    {digests.map(d => <li key={d.kind} data-testid="policy-digest" data-kind={d.kind} className="border-b border-border-default">
      <details>
        <summary className="flex min-h-11 cursor-pointer items-baseline gap-x-3 py-2.5 md:min-h-0">
          <span className="min-w-0 flex-1 text-title font-medium text-text-primary">{d.line}</span>
          <span className="shrink-0 text-meta text-text-secondary">Show {d.count}</span>
        </summary>
        <ul className="pb-1 pl-4">{d.items.map(i => <Row key={i.key} item={i} line={false} />)}</ul>
      </details>
    </li>)}
  </ul>;
}
