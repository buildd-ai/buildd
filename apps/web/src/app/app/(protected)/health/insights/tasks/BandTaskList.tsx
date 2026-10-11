'use client';

/**
 * Insights › a band's tasks: the chart's selection as Activity-style rows
 * (title, the Lifecycle track, one meta line), not the old task grid.
 */
import Link from 'next/link';
import { useState } from 'react';
import Lifecycle from '@/components/ui/Lifecycle';
import { displayTaskTitle } from '@/lib/task-title';
import { shortDuration } from '@/lib/mission-list-card';
import type { BandRow } from './band-rows';

export const BAND_ROW_PAGE = 50;

export default function BandTaskList({ label, rows, now }: { label: string; rows: readonly BandRow[]; now?: number }) {
  const [shown, setShown] = useState(BAND_ROW_PAGE);
  const at = now ?? Date.now();
  const visible = rows.slice(0, shown);
  const rest = rows.length - visible.length;
  return (
    <div data-testid="band-task-list" className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      <Link href="/app/health/insights" className="text-meta text-text-muted hover:text-text-secondary">‹ Insights</Link>
      <h1 className="mt-1 text-title font-semibold text-text-primary">{label}</h1>
      <p className="mt-1 text-meta text-text-muted">{rows.length === 1 ? '1 task' : `${rows.length} tasks`}</p>
      {rows.length === 0 ? (
        <p className="mt-6 text-body text-text-muted">No tasks in this part of the chart.</p>
      ) : (
        <ul className="mt-4">
          {visible.map(r => {
            const age = Math.max(0, at - Date.parse(r.updatedAt));
            const meta = [r.missionTitle, r.prNumber ? `PR #${r.prNumber}` : null, `${age < 60_000 ? 'just now' : `${shortDuration(age)} ago`}`].filter(Boolean).join(' · ');
            return (
              <li key={r.id} data-testid="band-task-row" className="border-t border-border-default py-3">
                <Link href={`/app/tasks/${r.id}`} className="block text-body font-medium text-text-primary hover:underline" title={r.title}>
                  {displayTaskTitle(r.title)}
                </Link>
                <Lifecycle state={r.state} className="mt-1" />
                <p className="mt-1 text-meta text-text-muted">{meta}</p>
              </li>
            );
          })}
        </ul>
      )}
      {rest > 0 && (
        <button type="button" data-testid="band-show-more" className="btn btn-quiet mt-3" onClick={() => setShown(n => n + BAND_ROW_PAGE)}>
          Show {Math.min(rest, BAND_ROW_PAGE)} more
        </button>
      )}
    </div>
  );
}
