'use client';

/**
 * The two sheets behind the model tiers table: "What ran" for one tier
 * (opened from the tier name, or from History), and History (the audited
 * changes to the team's cells, grouped by day, newest first, each with its
 * exact record one tap away).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ModelPolicyCell, ModelPolicyCellRun } from '@buildd/shared';
import Sheet from '@/components/ui/Sheet';
import { SURFACE_LABEL, cellRoutes, pctText } from '@/lib/model-policy-cells-view';

/** Percent, but never a rounded-away "0%" or "100%" for a share that is neither. */
export function sharePct(x: number): string {
  if (x > 0 && x < 0.005) return '<1%';
  if (x < 1 && x >= 0.995) return '>99%';
  return pctText(x);
}
const usd = (x: number) => `$${x < 1 ? x.toFixed(2) : x.toFixed(1)}`;
/** Below this many graded runs a percentage is noise: show the counts instead. */
const MIN_FOR_PCT = 5;

/** "80% (8 of 10)", or "3 of 4" when too few to be a rate, or null when none are graded. */
export function outcomeText(rate: number | null | undefined, n: number | undefined): string {
  if (rate == null || !n) return 'not measured';
  const k = Math.round(rate * n);
  return n >= MIN_FOR_PCT ? `${pctText(rate)} (${k} of ${n})` : `${k} of ${n}`;
}

function Stat({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-meta text-text-muted">{label}</dt>
      <dd className="text-body tabular-nums text-text-primary">{children}</dd>
    </div>
  );
}

const dayText = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function RunStatus({ merged }: { merged: boolean | null }) {
  return <>{merged === true ? 'Changes merged' : merged === false ? 'Not merged' : 'Outcome pending'}</>;
}

function RunTable({ cell, windowDays }: { cell: ModelPolicyCell; windowDays: number }) {
  const chat = cell.surface === 'chat';
  const unit = chat ? 'conversations' : 'runs';
  const total = cell.whatRan.reduce((s, m) => s + m.runs, 0);
  const recent = cell.whatRan
    .flatMap((m) => m.recentRuns.map((r) => ({ ...r, model: m.model })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8);
  return (
    <section aria-label={SURFACE_LABEL[cell.surface]} data-testid={`what-ran-${cell.surface}`}>
      <h3 className="text-title font-semibold text-text-primary">{SURFACE_LABEL[cell.surface]}</h3>
      {total > 0 && (
        <p className="mb-2 text-meta text-text-muted" data-testid="what-ran-denominator">
          Share of {total} {total === 1 ? unit.replace(/s$/, '') : unit} in the last {windowDays} days
        </p>
      )}
      {cell.whatRan.length === 0 && (
        <p className="py-2 text-meta text-text-muted" data-testid="what-ran-empty">
          {chat ? 'No chats on this tier in the last' : 'No runs on this tier in the last'} {windowDays} days.
          {chat && cell.qualitySignal === 'none' ? ' Chat quality scoring is off, so satisfaction is not measured.' : ''}
        </p>
      )}
      <ul className="divide-y divide-border-default">
        {cell.whatRan.map((m) => (
          <li key={m.model} className="py-2.5" data-testid="what-ran-model">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-all font-semibold text-text-primary" title={m.model}>{m.model}</span>
              <span className="shrink-0 tabular-nums text-text-primary">{sharePct(m.share)}</span>
            </div>
            <div className="mt-1.5 h-1 bg-surface-2" aria-hidden="true">
              <div className="h-full bg-accent" style={{ width: `${Math.max(m.share > 0 ? 2 : 0, Math.round(m.share * 100))}%` }} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
              <Stat label="Ran">{m.runs} {m.runs === 1 ? 'time' : 'times'}</Stat>
              {chat ? (
                <>
                  <Stat label="Satisfied">{m.satisfiedRate == null ? 'not measured' : pctText(m.satisfiedRate)}</Stat>
                  <Stat label="Thumbs">{m.thumbsUp == null && m.thumbsDown == null ? 'none' : `${m.thumbsUp ?? 0} up · ${m.thumbsDown ?? 0} down`}</Stat>
                  <Stat label="Re-asked">{m.reaskedRate == null ? 'not measured' : pctText(m.reaskedRate)}</Stat>
                  <Stat label="Average cost">{m.costPerRunUsd == null ? 'not measured' : `${usd(m.costPerRunUsd)} per conversation`}</Stat>
                </>
              ) : (
                <>
                  <Stat label="Changes merged">{outcomeText(m.mergedRate, m.mergedGraded)}</Stat>
                  <Stat label="Passed review">{outcomeText(m.reviewOkRate, m.reviewOkGraded)}</Stat>
                  <Stat label="Average cost">{m.costPerRunUsd == null ? 'not measured' : `${usd(m.costPerRunUsd)} per run`}</Stat>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {recent.length > 0 && (
        <>
          <h4 className="mt-4 mb-1 text-meta font-semibold text-text-muted">Recent runs</h4>
          <ul className="divide-y divide-border-default" data-testid="what-ran-recent">
            {recent.map((r) => (
              <li key={r.taskId} className="py-2">
                <Link href={`/app/tasks/${r.taskId}`} className="block truncate text-body text-text-primary hover:underline">
                  {r.title || 'Untitled task'}
                </Link>
                <p className="flex flex-wrap gap-x-2 text-meta text-text-muted">
                  <span className="min-w-0 truncate" title={r.model}>{r.model}</span>
                  <span>·</span><RunStatus merged={r.merged} /><span>·</span><span>{dayText(r.at)}</span>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function WhatRanSheet({ tier, cells, windowDays, onClose }: {
  tier: string; cells: readonly ModelPolicyCell[]; windowDays: number; onClose: () => void;
}) {
  const routing = cells.filter((c) => c.tier === tier && cellRoutes(c));
  return (
    <Sheet open onClose={onClose} title={`${tier} · what ran`} width="wide" height="tall" testId="what-ran-sheet">
      <div className="space-y-8">
        {routing.map((c) => <RunTable key={c.surface} cell={c} windowDays={windowDays} />)}
        {routing.length === 0 && <p className="text-meta text-text-muted">This tier always uses its primary.</p>}
      </div>
    </Sheet>
  );
}

export interface ChangeView { id: string; kind: string; at: string; actor: string | null; before?: Record<string, unknown> | null; after: Record<string, unknown> | null; reason?: string | null }
type CellChange = ChangeView & { cell: string };

const isSystem = (c: ChangeView) => c.actor != null && c.actor.startsWith('system');

/** One plain sentence for a change. A recommendation never reads as a traffic change. */
export function changeSummary(c: ChangeView): string {
  const a = c.after ?? {};
  const model = typeof a.model === 'string' ? a.model : null;
  switch (c.kind) {
    case 'suggestion': return 'Model recommendation updated';
    case 'suggestion_dismissed': return 'Model recommendation dismissed';
    case 'arm_added': return model ? `Added ${model} to evaluate` : 'Added an alternative to evaluate';
    case 'arm_removed': return 'Removed an alternative';
    case 'allocation': return isSystem(c) ? 'Traffic split adjusted automatically' : 'Changed the alternatives’ share';
    case 'mode':
      return a.mode === 'pinned' ? 'Returned to the selected model'
        : a.mode === 'explore' ? 'Evaluating alternatives'
        : a.mode === 'split' ? 'Set a fixed split' : 'Routing mode changed';
    case 'promotion': return 'Trial on real work started';
    case 'revert': return 'Returned to primary';
    case 'freeze': return 'Paused automatic changes';
    case 'unfreeze': return 'Resumed automatic changes';
    case 'dial': return 'Changed how far traffic may move';
    default: return c.reason === 'pool_created' ? 'Set up routing for this tier' : 'Routing updated';
  }
}

/** Recommendations are advice; everything else here changed (or could change) what serves traffic. */
const isSuggestion = (c: ChangeView) => c.kind === 'suggestion' || c.kind === 'suggestion_dismissed';

export interface HistoryEntry { key: string; cell: string; summary: string; at: string; items: CellChange[]; suggestionOnly: boolean }
export interface HistoryDay { day: string; entries: HistoryEntry[] }

/**
 * Newest first, grouped by day. Consecutive low-level events of one cell and
 * kind (other cells' rows may sit between them) (automatic traffic nudges, repeated recommendations) fold into one row;
 * every folded event stays in `items` for the disclosure.
 */
export function groupHistory(changes: readonly CellChange[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const c of [...changes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const day = dayText(c.at);
    let d = days[days.length - 1];
    if (!d || d.day !== day) { d = { day, entries: [] }; days.push(d); }
    const prev = [...d.entries].reverse().find((e) => e.cell === c.cell);
    const summary = changeSummary(c);
    if (prev && prev.summary === summary && (c.kind === 'allocation' || isSuggestion(c))) {
      prev.items.push(c);
    } else {
      d.entries.push({ key: c.id, cell: c.cell, summary, at: c.at, items: [c], suggestionOnly: isSuggestion(c) });
    }
  }
  return days;
}

function ChangeDetail({ c }: { c: CellChange }) {
  const time = new Date(c.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="border-l border-border-default pl-3" data-testid="history-detail-item">
      <p className="text-text-primary">{time} · {c.kind}{c.actor ? ` · by ${c.actor}` : ''}</p>
      {c.reason && <p className="break-words">{c.reason}</p>}
      {c.after && Object.keys(c.after).length > 0 && (
        <p className="break-all font-mono">{JSON.stringify(c.after)}</p>
      )}
    </div>
  );
}

export function HistorySheet({ teamId, cells, onClose, onWhatRan }: {
  teamId: string; cells: readonly ModelPolicyCell[]; onClose: () => void; onWhatRan: (tier: string) => void;
}) {
  const [changes, setChanges] = useState<CellChange[] | null>(null);
  const pooled = cells.filter((c) => c.poolId);
  const key = pooled.map((c) => c.poolId).join(',');

  useEffect(() => {
    let cancelled = false;
    Promise.all(pooled.map(async (c) => {
      const res = await fetch(`/api/model-tiers/pools/${c.poolId}?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
      const d = res?.ok ? await res.json().catch(() => null) : null;
      const list: ChangeView[] = Array.isArray(d?.changes) ? d.changes : [];
      return list.map((x) => ({ ...x, cell: `${c.tier} ${SURFACE_LABEL[c.surface].toLowerCase()}` }));
    })).then((all) => {
      if (!cancelled) setChanges(all.flat());
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, key]);

  const routingTiers = [...new Set(cells.filter(cellRoutes).map((c) => c.tier))];
  const days = changes ? groupHistory(changes) : [];
  return (
    <Sheet open onClose={onClose} title="History" width="wide" height="tall" testId="history-sheet">
      {routingTiers.length > 0 && (
        <p className="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-muted">
          What ran:
          {routingTiers.map((t) => (
            <button key={t} type="button" className="text-accent-text underline hover:no-underline" onClick={() => onWhatRan(t)} data-testid={`history-what-ran-${t}`}>{t}</button>
          ))}
        </p>
      )}
      <div data-testid="history-changes">
        {changes === null && <p className="text-meta text-text-muted">Loading…</p>}
        {changes?.length === 0 && <p className="text-meta text-text-muted">No changes.</p>}
        {days.map((d) => (
          <section key={d.day} className="mb-5" data-testid="history-day">
            <h3 className="mb-1 text-meta font-semibold text-text-muted">{d.day}</h3>
            <ul className="divide-y divide-border-default">
              {d.entries.map((e) => (
                <li key={e.key} data-testid="history-entry">
                  <details className="group py-2">
                    <summary className="cursor-pointer list-none">
                      <span className="block text-body text-text-primary">
                        {e.summary}{e.items.length > 1 ? ` (${e.items.length} updates)` : ''}
                      </span>
                      <span className="block text-meta text-text-muted">
                        {e.cell}{e.suggestionOnly ? ' · suggestion only, traffic unchanged' : ''}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-2 text-meta text-text-muted" data-testid="history-detail">
                      {e.items.map((c) => <ChangeDetail key={c.id} c={c} />)}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
