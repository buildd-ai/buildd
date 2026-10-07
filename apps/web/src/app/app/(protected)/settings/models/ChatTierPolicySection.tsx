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
    <div className="mt-6 max-w-5xl" data-testid="chat-tier-policy">
      <div className="card flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-4">
        <span id="chat-default-tier-label" className="font-mono text-body text-text-primary">New chats start at</span>
        <Select
          aria-labelledby="chat-default-tier-label"
          testId="chat-default-tier"
          className="w-full sm:w-40"
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
        <span className="flex items-center gap-2 sm:ml-auto" title="On: a higher tier resets down to the default; a lower one is kept.">
          <span id="chat-tier-cap-label" className="font-mono text-body text-text-primary">Cap at this tier</span>
          <Switch
            labelledBy="chat-tier-cap-label"
            checked={cap}
            disabled={disabled}
            onChange={(next) => {
              const before = cap;
              setCap(next);
              void save({ chatCapNewSessionTier: next }, () => setCap(before));
            }}
          />
        </span>
      </div>
      {msg && <span role="status" className={`mt-1 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>}
    </div>
  );
}
