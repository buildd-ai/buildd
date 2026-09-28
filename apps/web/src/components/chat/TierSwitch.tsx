'use client';

/**
 * The composer's tier switch: Auto (routed per turn) or one of the chat tiers
 * for this conversation. A tier, never a model: which model backs a tier is
 * the team admin's.
 *
 * The picker is the kit's (`TierPicker` from @builddai/ai-kit/chat/react); this
 * owns buildd's `/api/chat/tiers` fetch and the pricing detail: each option
 * names its model and its expected price per 1k tokens (averaged over the
 * tier's models when it's pooled), and hovering the cell (desktop) shows the
 * shown tier's detail plus what this conversation has cost so far.
 */
import { useEffect, useState } from 'react';
import { TierPicker, formatCost, formatPer1k, type TierOption } from '@builddai/ai-kit/chat/react';
import type { ChatTierInfo, ChatTierName, GetChatTiersResponse } from '@buildd/shared';
import KitMenuCell from './KitMenuCell';

const TIERS: readonly ChatTierName[] = ['budget', 'standard', 'premium'];

/** A tier's model (`+N` when pooled). */
function modelLine(info: ChatTierInfo): string {
  return info.models.length > 1 ? `${info.model} +${info.models.length - 1}` : info.model;
}

/** The kit's options, each with "model · $in / $out per 1k" once the tiers load. */
export function tierOptions(tiers: readonly ChatTierInfo[] | null | undefined): TierOption[] {
  return TIERS.map(tier => {
    const info = tiers?.find(t => t.tier === tier);
    return info
      ? { tier, price: `${modelLine(info)} · ${formatPer1k(info.inputPer1kUsd)} / ${formatPer1k(info.outputPer1kUsd)} per 1k` }
      : { tier };
  });
}

export function TierDetail({ info, cost }: { info: ChatTierInfo | null; cost: number | null }) {
  const spent = formatCost(cost);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11.5px]">
      {info && (
        <>
          <dt className="text-text-muted">Model</dt>
          <dd className="min-w-0 truncate text-text-primary">{modelLine(info)}</dd>
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

  const shown = pinned ?? last ?? 'standard';
  const info = data?.tiers.find(t => t.tier === shown) ?? null;

  return (
    <KitMenuCell testId="composer-tier" hover={<TierDetail info={info} cost={data?.conversationCostUsd ?? null} />}>
      <TierPicker
        value={pinned}
        last={last}
        onChange={t => onChange(t as ChatTierName | null)}
        options={tierOptions(data?.tiers)}
        title="Tier"
      />
    </KitMenuCell>
  );
}
