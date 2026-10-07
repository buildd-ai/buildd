'use client';

/**
 * The two sheets behind the model tiers table: "What ran" for one tier
 * (opened from the tier name, or from History), and History (every audited
 * change to the team's cells, newest first).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ModelPolicyCell, ModelPolicyCellRun } from '@buildd/shared';
import Sheet from '@/components/ui/Sheet';
import { SURFACE_LABEL, cellRoutes, pctText } from '@/lib/model-policy-cells-view';

const rate = (x: number | null | undefined) => (x == null ? '–' : pctText(x));
const usd = (x: number | null | undefined) => (x == null ? '–' : `$${x < 1 ? x.toFixed(2) : x.toFixed(1)}`);

function ShareBar({ share }: { share: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-16 border border-border-default bg-surface-2" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="tabular-nums text-text-primary">{pctText(share)}</span>
    </span>
  );
}

function RunTable({ cell }: { cell: ModelPolicyCell }) {
  const chat = cell.surface === 'chat';
  const cols = chat
    ? ['Share', 'Satisfied', 'Thumbs', 'Re-asked', '$/conversation']
    : ['Share', 'Merged', 'Review ok', '$/run'];
  const cells = (m: ModelPolicyCellRun) => chat
    ? [<ShareBar key="s" share={m.share} />, rate(m.satisfiedRate), m.thumbsUp == null && m.thumbsDown == null ? '–' : `${m.thumbsUp ?? 0} up · ${m.thumbsDown ?? 0} down`, rate(m.reaskedRate), usd(m.costPerRunUsd)]
    : [<ShareBar key="s" share={m.share} />, rate(m.mergedRate), rate(m.reviewOkRate), usd(m.costPerRunUsd)];
  const grid = chat ? 'md:grid-cols-[minmax(0,1fr)_110px_72px_100px_72px_100px]' : 'md:grid-cols-[minmax(0,1fr)_110px_72px_80px_64px]';
  const recent = cell.whatRan
    .flatMap((m) => m.recentRuns.map((r) => ({ ...r, model: m.model })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8);
  return (
    <section aria-label={SURFACE_LABEL[cell.surface]} data-testid={`what-ran-${cell.surface}`} className="font-mono">
      <h3 className="mb-1.5 text-title font-semibold text-text-primary">{SURFACE_LABEL[cell.surface]}</h3>
      <div className={`hidden md:grid ${grid} gap-3 border-b-2 border-border-strong pb-1 text-meta text-text-muted`}>
        <span>Model</span>{cols.map((c) => <span key={c}>{c}</span>)}
      </div>
      {cell.whatRan.length === 0 && <p className="py-2 text-meta text-text-muted">Nothing ran.</p>}
      {cell.whatRan.map((m) => (
        <div key={m.model} className={`grid grid-cols-2 ${grid} gap-x-3 gap-y-1 border-b border-border-default py-1.5 text-body`} data-testid="what-ran-model">
          <span className="col-span-2 md:col-span-1 truncate font-semibold text-text-primary" title={m.model}>{m.model}</span>
          {cells(m).map((v, i) => (
            <span key={cols[i]} className="tabular-nums text-text-primary">
              <span className="md:hidden text-meta text-text-muted">{cols[i]} </span>{v}
            </span>
          ))}
        </div>
      ))}
      {recent.length > 0 && (
        <>
          <h4 className="mt-3 mb-1 text-meta font-semibold text-text-muted">Recent runs</h4>
          <ul className="space-y-1 text-meta" data-testid="what-ran-recent">
            {recent.map((r) => (
              <li key={r.taskId} className="flex items-center gap-3">
                <Link href={`/app/tasks/${r.taskId}`} className="min-w-0 flex-1 truncate text-text-primary hover:underline">{r.model}</Link>
                <span className="text-text-muted">{r.merged == null ? 'not graded' : r.merged ? 'merged' : 'not merged'}</span>
                <span className="shrink-0 text-text-muted">{new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
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
      <p className="mb-3 text-meta text-text-muted">Last {windowDays} days.</p>
      <div className="space-y-6">
        {routing.map((c) => <RunTable key={c.surface} cell={c} />)}
        {routing.length === 0 && <p className="text-meta text-text-muted">This tier always uses its primary.</p>}
      </div>
    </Sheet>
  );
}

interface ChangeView { id: string; kind: string; at: string; actor: string | null; after: Record<string, unknown> | null; reason?: string | null }

const CHANGE_LABEL: Record<string, string> = {
  allocation: 'Traffic changed', arm_added: 'Model added', arm_removed: 'Model removed', mode: 'Mode changed',
  freeze: 'Frozen', unfreeze: 'Unfrozen', promotion: 'Shifted to an alternate', revert: 'Back to primary', dial: 'Dial changed',
};

function changeDetail(c: ChangeView): string {
  const a = c.after ?? {};
  if (c.kind === 'arm_added' && typeof a.model === 'string') return ` · ${a.model}`;
  if (c.kind === 'mode' && typeof a.mode === 'string') return ` · ${a.mode}`;
  if (c.kind === 'dial' && typeof a.dial === 'number') return ` · ${a.dial}`;
  return '';
}

export function HistorySheet({ teamId, cells, onClose, onWhatRan }: {
  teamId: string; cells: readonly ModelPolicyCell[]; onClose: () => void; onWhatRan: (tier: string) => void;
}) {
  const [changes, setChanges] = useState<Array<ChangeView & { cell: string }> | null>(null);
  const pooled = cells.filter((c) => c.poolId);
  const key = pooled.map((c) => c.poolId).join(',');

  useEffect(() => {
    let cancelled = false;
    Promise.all(pooled.map(async (c) => {
      const res = await fetch(`/api/model-tiers/pools/${c.poolId}?teamId=${teamId}`, { cache: 'no-store', credentials: 'include' }).catch(() => null);
      const d = res?.ok ? await res.json().catch(() => null) : null;
      const list: ChangeView[] = Array.isArray(d?.changes) ? d.changes : [];
      return list.map((x) => ({ ...x, cell: `${c.tier} · ${SURFACE_LABEL[c.surface]}` }));
    })).then((all) => {
      if (!cancelled) setChanges(all.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, key]);

  const routingTiers = [...new Set(cells.filter(cellRoutes).map((c) => c.tier))];
  return (
    <Sheet open onClose={onClose} title="History" width="wide" height="tall" testId="history-sheet">
      {routingTiers.length > 0 && (
        <p className="mb-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-meta text-text-muted">
          What ran:
          {routingTiers.map((t) => (
            <button key={t} type="button" className="text-accent-text underline hover:no-underline" onClick={() => onWhatRan(t)} data-testid={`history-what-ran-${t}`}>{t}</button>
          ))}
        </p>
      )}
      <ul className="space-y-1.5 font-mono text-meta" data-testid="history-changes">
        {changes === null && <li className="text-text-muted">Loading…</li>}
        {changes?.length === 0 && <li className="text-text-muted">No changes.</li>}
        {changes?.map((c) => (
          <li key={c.id} className="flex flex-wrap justify-between gap-x-3">
            <span className="min-w-0 text-text-primary">
              <span className="text-text-muted">{c.cell}</span> {CHANGE_LABEL[c.kind] ?? c.kind}{changeDetail(c)}
              {c.reason && <span className="block text-text-muted">{c.reason}</span>}
            </span>
            <span className="shrink-0 text-text-muted">
              {new Date(c.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{c.actor ? ` · ${c.actor}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
