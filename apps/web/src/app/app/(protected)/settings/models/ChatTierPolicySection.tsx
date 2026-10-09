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
 * higher remembered tier down to the default when a chat opened, and the person
 * could still pick higher afterwards. It no longer has a control. A team that
 * still has it on sees it explained once, with two ways out: turn the reset off,
 * or make the starting tier an enforced Chat maximum. Neither happens silently.
 */
export default function ChatTierPolicySection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [tier, setTier] = useState<ChatTierName | null>(null);
  const [legacyReset, setLegacyReset] = useState(false);
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
        setLegacyReset(d.team.chatCapNewSessionTier === true);
      }
      setChatMax(c?.effective?.chat?.max ?? null);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [teamId]);

  async function save(body: { chatDefaultTier?: ChatTierName | null; chatCapNewSessionTier?: boolean }, undo: () => void) {
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

  /** Move the old reset into an enforced Chat maximum, then switch the reset off. */
  async function makeEnforced() {
    if (!tier) return;
    setMsg(null);
    try {
      const cur = await fetch(`/api/teams/${teamId}/model-ceilings`).then((r) => r.json());
      const res = await fetch(`/api/teams/${teamId}/model-ceilings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team: { ...(cur?.policy?.team ?? {}), chat: tier } }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setChatMax(tier);
      setLegacyReset(false);
      await save({ chatCapNewSessionTier: false }, () => setLegacyReset(true));
      window.location.reload();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    }
  }

  const disabled = !isAdmin || !loaded;
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
            <span className="block text-meta text-text-muted">A default only. People can change the tier in a chat; the limit is Maximum allowed above.</span>
          </span>
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
        </div>
        {startBlocked && (
          <p role="alert" className="text-meta text-status-warning" data-testid="starting-tier-blocked">
            {tier} is above the Chat maximum ({chatMax}), so new chats start at {chatMax}. Choose a lower starting tier{isAdmin ? ' or raise the maximum above' : ''}.
          </p>
        )}
        {legacyReset && (
          <div className="flex flex-col gap-2 border-t border-border-default pt-2" data-testid="legacy-reset-notice">
            <p className="text-meta text-text-muted">
              This team still resets chats that open above {tier ?? 'the starting tier'} down to it. That is a convenience, not a limit: people can pick higher afterwards.
            </p>
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-quiet min-h-11 md:min-h-8" data-testid="legacy-reset-off" disabled={!loaded}
                  onClick={() => { setLegacyReset(false); void save({ chatCapNewSessionTier: false }, () => setLegacyReset(true)); }}>
                  Turn the reset off
                </button>
                {tier && (
                  <button type="button" className="btn btn-quiet min-h-11 md:min-h-8" data-testid="legacy-reset-enforce" disabled={!loaded}
                    onClick={() => void makeEnforced()}>
                    Make {tier} the Chat maximum
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {msg && <span role="status" className={`mt-1 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>}
    </div>
  );
}
