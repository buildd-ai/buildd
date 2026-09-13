'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ActionQueueItem, DiscrepancyDirection } from '@/lib/action-queue';

interface WaitingOnYouDiscrepancyCardProps {
  item: ActionQueueItem;
}

type Mode = 'idle' | 'accepting' | 'flipping' | 'error';

const DIRECTION_LABEL: Record<DiscrepancyDirection, string> = {
  contradicted: 'Contradicted — needs a call',
  spec_ahead: 'Spec ahead — unbuilt work',
  code_ahead: 'Code ahead — doc fix',
};

function ageLabel(hours: number | null | undefined): string | null {
  if (hours == null) return null;
  const days = Math.floor(hours / 24);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day old' : `${days} days old`;
}

/**
 * DISCREPANCY card for Home (docs/design/spec-conformance.md §12).
 *
 * Unlike WaitingOnYouDecideCard, the three exits (promote / accept / flip
 * direction) live directly on this card rather than a detail page — a
 * `spec_ahead` row has no mission to link to yet, so there is no "detail
 * page" to defer to until promote has already run. All three call the
 * §13 REST routes that back the equivalent MCP actions, so there is exactly
 * one mutation path whether a human clicks here or an agent calls the MCP
 * tool directly.
 */
export function WaitingOnYouDiscrepancyCard({ item }: WaitingOnYouDiscrepancyCardProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [reason, setReason] = useState('');
  const [newDirection, setNewDirection] = useState<'spec_ahead' | 'code_ahead'>('spec_ahead');

  if (!item.discrepancyId) return null;

  async function adjudicate(body: Record<string, unknown>) {
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await fetch(`/api/discrepancies/${item.discrepancyId}/adjudicate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not update the discrepancy');
      setMode('idle');
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
      setMode('error');
    } finally {
      setBusy(false);
    }
  }

  // Two-step, mirroring the promote_discrepancy MCP action exactly (mint a
  // mission through the same POST /api/missions primitive, then link it back
  // onto the row) — see packages/core/mcp-tools.ts's promote_discrepancy.
  async function promote() {
    setBusy(true);
    setErrorMsg('');
    try {
      const missionRes = await fetch('/api/missions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Spec discrepancy: ${item.assertionId} in ${item.specPath}`,
          description:
            `Promoted from discrepancy ledger row ${item.discrepancyId} ` +
            `(docs/design/spec-conformance.md §13).\n\n` +
            `Spec: ${item.specPath}\nAssertion: ${item.assertionId}\nDirection: ${item.direction}`,
          workspaceId: item.workspaceId,
        }),
      });
      const mission = await missionRes.json().catch(() => ({}));
      if (!missionRes.ok) throw new Error(mission.error || 'Could not create the mission');

      const linkRes = await fetch(`/api/discrepancies/${item.discrepancyId}/promote`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId: mission.id }),
      });
      const linked = await linkRes.json().catch(() => ({}));
      if (!linkRes.ok) throw new Error(linked.error || 'Mission created but could not be linked to the row');

      setMode('idle');
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error');
      setMode('error');
    } finally {
      setBusy(false);
    }
  }

  const direction = item.direction ?? 'code_ahead';
  const age = ageLabel(item.cardAgeHours);

  return (
    <div className="border-l-2 border-status-warning bg-status-warning/5 rounded-r-[10px] px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-[10px] font-mono font-medium text-status-warning tracking-wide uppercase">
              Discrepancy
            </span>
            <span className="text-[11px] text-text-muted">{DIRECTION_LABEL[direction]}</span>
            {age && <span className="text-[10px] text-text-muted">· {age}</span>}
          </div>
          <div className="text-[13px] font-medium text-text-primary truncate mb-0.5">
            {item.specPath}
          </div>
          <div className="text-[12px] text-text-secondary font-mono truncate">
            {item.assertionId}
          </div>
        </div>

        {mode === 'idle' && (
          <div className="flex-shrink-0 flex items-center gap-2">
            {item.promotedMissionId ? (
              <Link
                href={`/app/missions/${item.promotedMissionId}`}
                className="text-[12px] font-medium text-primary hover:underline whitespace-nowrap"
              >
                View mission →
              </Link>
            ) : direction === 'spec_ahead' ? (
              <button
                type="button"
                onClick={promote}
                disabled={busy}
                className="text-[12px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors rounded-md px-2.5 py-1 whitespace-nowrap disabled:opacity-60"
              >
                {busy ? 'Promoting…' : 'Promote'}
              </button>
            ) : null}
            {direction === 'contradicted' && (
              <button
                type="button"
                onClick={() => setMode('flipping')}
                disabled={busy}
                className="text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border rounded-md px-2.5 py-1 whitespace-nowrap disabled:opacity-60"
              >
                Flip direction
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode('accepting')}
              disabled={busy}
              className="text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border rounded-md px-2.5 py-1 whitespace-nowrap disabled:opacity-60"
            >
              Accept
            </button>
          </div>
        )}
      </div>

      {mode === 'accepting' && (
        <div className="mt-2 pt-2 border-t border-status-warning/20 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for accepting (required)…"
            rows={2}
            className="w-full px-2.5 py-1.5 rounded-sm bg-surface-1 border border-border-default text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setMode('idle'); setReason(''); }}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => adjudicate({ action: 'accept', reason: reason.trim() })}
              className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 transition-colors rounded-md px-2.5 py-1 disabled:opacity-60"
            >
              {busy ? 'Accepting…' : 'Confirm accept'}
            </button>
          </div>
        </div>
      )}

      {mode === 'flipping' && (
        <div className="mt-2 pt-2 border-t border-status-warning/20 space-y-2">
          <div className="flex items-center gap-3 text-[12px] text-text-secondary">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`flip-${item.discrepancyId}`}
                checked={newDirection === 'spec_ahead'}
                onChange={() => setNewDirection('spec_ahead')}
              />
              Spec ahead
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`flip-${item.discrepancyId}`}
                checked={newDirection === 'code_ahead'}
                onChange={() => setNewDirection('code_ahead')}
              />
              Code ahead
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary transition-colors px-2 py-0.5 border border-border-default rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => adjudicate({ action: 'flip_direction', newDirection })}
              className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 transition-colors rounded-md px-2.5 py-1 disabled:opacity-60"
            >
              {busy ? 'Updating…' : 'Confirm flip'}
            </button>
          </div>
        </div>
      )}

      {mode === 'error' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-status-error min-w-0">{errorMsg}</span>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="text-[11px] text-text-muted hover:text-text-secondary underline flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
