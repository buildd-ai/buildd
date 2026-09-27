'use client';

import { useEffect, useState } from 'react';
import { CHAT_TIER_NAMES, isChatTierName, type ChatTierName } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';

const TIER_OPTIONS = [
  { value: 'auto', label: 'auto', description: 'No cap' },
  ...CHAT_TIER_NAMES.map((t) => ({ value: t, label: t })),
];

/**
 * The tier a new chat starts at: `teams.chatDefaultTier` and
 * `chatCapNewSessionTier` (lib/chat/composer-prefs.ts). Off, a new chat starts
 * at the person's last tier. On, it is capped at the default: reset down to
 * it, never up. A default of auto caps nothing. Each change saves on its own.
 */
export default function ChatTierPolicySection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [tier, setTier] = useState<ChatTierName | null>(null);
  const [cap, setCap] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/teams/${teamId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.team) return;
        setTier(isChatTierName(d.team.chatDefaultTier) ? d.team.chatDefaultTier : null);
        setCap(d.team.chatCapNewSessionTier === true);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
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
    } catch (e) {
      undo();
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    }
  }

  const disabled = !isAdmin || !loaded;

  return (
    <div className="mt-10 max-w-4xl" data-testid="chat-tier-policy">
      <h2 className="mb-2 flex items-baseline gap-2 font-mono text-[15px] font-bold text-text-primary">
        New chats <span className="text-[12px] font-normal text-text-muted">the tier a new conversation starts at</span>
      </h2>
      <div className="card divide-y divide-border-default">
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <span className="min-w-0">
            <span id="chat-tier-cap-label" className="block text-sm text-text-primary">Cap new chats at the team default</span>
            <span className="block text-xs text-text-muted">
              Off: each person starts where they left off. On: a higher tier resets down to the default; a lower one is kept.
            </span>
          </span>
          <Switch
            labelledBy="chat-tier-cap-label"
            className="mt-1"
            checked={cap}
            disabled={disabled}
            onChange={(next) => {
              const before = cap;
              setCap(next);
              void save({ chatCapNewSessionTier: next }, () => setCap(before));
            }}
          />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 px-4 py-3">
          <span id="chat-default-tier-label" className="text-sm text-text-primary">Team default tier</span>
          <Select
            aria-labelledby="chat-default-tier-label"
            testId="chat-default-tier"
            className="w-full sm:w-44"
            options={TIER_OPTIONS}
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
      </div>
      <div className="mt-2 min-h-5">
        {isAdmin
          ? msg && <span role="status" className={`text-xs ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>
          : <p className="text-xs text-text-muted">Only a team owner or admin can change this.</p>}
      </div>
    </div>
  );
}
