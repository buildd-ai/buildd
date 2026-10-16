'use client';

import { useEffect, useState } from 'react';
import { CHAT_TIER_NAMES, isChatTierName, type ChatTierName } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import { isCeilingTier, tierRank, type CeilingTier } from '@buildd/shared';

/**
 * The tier a new chat starts at (`teams.chatDefaultTier`): a default people can
 * change. It is NOT a limit; the enforced limit is "Maximum allowed" above.
 * A starting tier the maximum blocks is shown disabled, with why.
 *
 * `chatCapNewSessionTier` was the old "Cap at this tier" switch: it reset a
 * higher remembered tier down to the default when a chat opened. It has no
 * control and no notice here. lib/chat/composer-prefs-store.ts still honours a
 * stored `true`; follow-up: once no team has it on, drop the column and that
 * read (PATCH /api/teams/[id] still accepts `chatCapNewSessionTier: false`).
 */
export default function ChatTierPolicySection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [tier, setTier] = useState<ChatTierName | null>(null);
  const [chatMax, setChatMax] = useState<CeilingTier | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/teams/${teamId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/teams/${teamId}/model-ceilings`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([d, c]) => {
      if (cancelled) return;
      if (d?.team) {
        setTier(isChatTierName(d.team.chatDefaultTier) ? d.team.chatDefaultTier : null);
      }
      setChatMax(c?.effective?.chat?.max ?? null);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [teamId]);

  async function save(body: { chatDefaultTier?: ChatTierName | null }, undo: () => void) {
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setMsg({ tone: 'ok', text: 'Saved' });
      return true;
    } catch (e) {
      undo();
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
      return false;
    }
  }

  const disabled = !loaded;
  const options = [
    { value: 'auto', label: 'auto', description: 'Last tier used' },
    ...CHAT_TIER_NAMES.map((t) => {
      const blocked = !!chatMax && isCeilingTier(t) && tierRank(t) > tierRank(chatMax);
      return { value: t, label: t, disabled: blocked, description: blocked ? `Above the Chat maximum (${chatMax})` : undefined };
    }),
  ];
  const startBlocked = !!chatMax && !!tier && isCeilingTier(tier) && tierRank(tier) > tierRank(chatMax);

  return (
    <div className="mt-6" data-testid="chat-tier-policy">
      <div className="flex flex-col gap-2 border-t border-border-default py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <span className="min-w-0 flex-1">
            <span id="chat-default-tier-label" className="block text-sm font-semibold text-text-primary">Starting tier for new chats</span>
            <span className="block text-meta text-text-muted">This is only the default. People can change the tier in a chat; the limit is Maximum allowed above.</span>
          </span>
          {!isAdmin ? (
            // Read-only: the value, no control (the page says who manages it).
            <span className="text-sm text-text-primary sm:text-right" data-testid="chat-default-tier-value">{loaded ? (tier ?? 'auto') : '…'}</span>
          ) : (
          <Select
            aria-labelledby="chat-default-tier-label"
            testId="chat-default-tier"
            className="w-full sm:w-40"
            options={options}
            value={tier ?? 'auto'}
            disabled={disabled}
            onChange={(v: string) => {
              const next = isChatTierName(v) ? v : null;
              const before = tier;
              setTier(next);
              void save({ chatDefaultTier: next }, () => setTier(before));
            }}
          />
          )}
        </div>
        {startBlocked && (
          <p role="alert" className="text-meta text-status-warning" data-testid="starting-tier-blocked">
            {tier} is above the Chat maximum ({chatMax}), so new chats start at {chatMax}.{isAdmin ? ' Choose a lower starting tier or raise the maximum above.' : ''}
          </p>
        )}
      </div>
      {msg && <span role="status" className={`mt-1 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>}
    </div>
  );
}
