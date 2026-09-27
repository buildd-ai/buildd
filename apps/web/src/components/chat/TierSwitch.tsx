'use client';

/**
 * The composer's tier switch: Auto (routed per turn) or one of the chat tiers
 * for this conversation. Hover (desktop) or the open menu shows each tier's
 * model, its expected price per 1k tokens (averaged over the tier's models when
 * it's pooled) and what this conversation has cost so far. A tier, never a
 * model: which model backs a tier is the team admin's.
 */
import { useEffect, useState } from 'react';
import type { ChatTierInfo, ChatTierName, GetChatTiersResponse } from '@buildd/shared';
import ComposerMenu from './ComposerMenu';
import { formatCost, formatPer1k, tierChipLabel } from './composer-format';

export function TierDetail({ info, cost }: { info: ChatTierInfo | null; cost: number | null }) {
  const spent = formatCost(cost);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11.5px]">
      {info && (
        <>
          <dt className="text-text-muted">Model</dt>
          <dd className="min-w-0 truncate text-text-primary">{info.models.length > 1 ? `${info.model} +${info.models.length - 1}` : info.model}</dd>
          <dt className="text-text-muted">Per 1k</dt>
          <dd className="text-text-primary">{`${formatPer1k(info.inputPer1kUsd)} in · ${formatPer1k(info.outputPer1kUsd)} out`}</dd>
        </>
      )}
      <dt className="text-text-muted">This chat</dt>
      <dd data-testid="tier-chat-cost" className="text-text-primary">{spent || '$0'}</dd>
    </dl>
  );
}

export default function TierSwitch({ teamId, conversationId, pinned, last, onChange, refreshKey = 0 }: {
  teamId: string;
  conversationId: string | null;
  pinned: ChatTierName | null;
  /** The tier the latest turn ran on. */
  last: string | null;
  onChange(tier: ChatTierName | null): void;
  /** Bump after a turn to refresh the running cost. */
  refreshKey?: number;
}) {
  const [data, setData] = useState<GetChatTiersResponse | null>(null);

  useEffect(() => {
    let live = true;
    const q = conversationId ? `conversationId=${encodeURIComponent(conversationId)}` : `teamId=${encodeURIComponent(teamId)}`;
    fetch(`/api/chat/tiers?${q}`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<GetChatTiersResponse> : null))
      .then(b => { if (live && b) setData(b); })
      .catch(() => {});
    return () => { live = false; };
  }, [teamId, conversationId, refreshKey]);

  const cost = data?.conversationCostUsd ?? null;
  const shown = pinned ?? last ?? 'standard';
  const info = data?.tiers.find(t => t.tier === shown) ?? null;
  const spent = formatCost(cost);

  return (
    <ComposerMenu
      label={`Tier: ${tierChipLabel({ pinned, last })}`}
      title="Tier"
      testId="composer-tier-chip"
      align="right"
      hover={<TierDetail info={info} cost={cost} />}
      trigger={(
        <>
          <span className="max-w-[14ch] truncate">{tierChipLabel({ pinned, last })}</span>
          {spent && <span data-testid="composer-tier-cost" className="text-text-muted">{spent}</span>}
          <span aria-hidden="true" className="text-text-muted">▾</span>
        </>
      )}
    >
      {(close) => (
        <div>
          <div className="border-b border-border-default px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">Tier</div>
          <ul role="listbox" aria-label="Tier" className="py-1">
            {([null, 'budget', 'standard', 'premium'] as const).map(t => {
              const selected = t === pinned;
              const tInfo = t ? data?.tiers.find(x => x.tier === t) ?? null : null;
              return (
                <li key={t ?? 'auto'}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-tier={t ?? 'auto'}
                    onClick={() => { onChange(t); close(); }}
                    className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-mono hover:bg-surface-3 ${selected ? 'text-text-primary' : 'text-text-secondary'}`}
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold">{t ?? 'Auto'}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {t ? (tInfo ? `${tInfo.model} · ${formatPer1k(tInfo.inputPer1kUsd)} / ${formatPer1k(tInfo.outputPer1kUsd)} per 1k` : '') : 'Routed per message'}
                      </span>
                    </span>
                    {selected && <span aria-hidden="true" className="shrink-0 text-accent-text">✓</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border-default px-3 py-2 font-mono text-[12px] text-text-secondary">
            {`This chat: ${spent || '$0'}`}
          </div>
        </div>
      )}
    </ComposerMenu>
  );
}
