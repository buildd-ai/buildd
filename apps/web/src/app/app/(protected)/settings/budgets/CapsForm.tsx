'use client';

import { useEffect, useState } from 'react';
import type { KeyPolicy } from '@/lib/provider-keys-client';
import { budgetFromApi, parseBudgetInput } from './budget-input';

const perDay = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}/day`;

/**
 * Daily caps on interactive (server-side) spend: `teams.chatDailyBudgetUsd` and
 * `chatUserDailyBudgetUsd`. An empty field means the default, shown as the
 * placeholder. Under "each person's own key" there is no team cap and the
 * per-person cap defaults to none (lib/chat/limits.ts).
 */
export default function CapsForm({
  teamId, canManage, keyPolicy, defaultTeamUsd, defaultUserShare,
}: {
  teamId: string;
  canManage: boolean;
  keyPolicy: KeyPolicy;
  defaultTeamUsd: number;
  /** Fraction of the team cap one person may spend when no per-person cap is set. */
  defaultUserShare: number;
}) {
  const own = keyPolicy === 'own';
  const [team, setTeam] = useState('');
  const [user, setUser] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/teams/${teamId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.team) return;
        const t = budgetFromApi(d.team.chatDailyBudgetUsd);
        const u = budgetFromApi(d.team.chatUserDailyBudgetUsd);
        setTeam(t === null ? '' : perDay(t));
        setUser(u === null ? '' : perDay(u));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [teamId]);

  const teamParsed = parseBudgetInput(team);
  const userParsed = parseBudgetInput(user);
  const effectiveTeam = teamParsed.ok && teamParsed.value !== null ? teamParsed.value : defaultTeamUsd;
  const ok = userParsed.ok && (own || teamParsed.ok);

  async function save() {
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = own
        ? { chatUserDailyBudgetUsd: userParsed.ok ? userParsed.value : null }
        : { chatDailyBudgetUsd: teamParsed.ok ? teamParsed.value : null, chatUserDailyBudgetUsd: userParsed.ok ? userParsed.value : null };
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setMsg({ tone: 'ok', text: 'Saved' });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  const field = (
    id: string, label: string, value: string, set: (v: string) => void, placeholder: string,
    parsed: ReturnType<typeof parseBudgetInput>,
  ) => (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 px-4 py-3">
      <label htmlFor={id} className="text-sm text-text-primary">{label}</label>
      <div className="sm:text-right">
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={placeholder}
          disabled={!canManage || !loaded}
          className="w-full sm:w-36 h-11 sm:h-9 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-sm sm:text-right disabled:opacity-60"
        />
        {!parsed.ok && <p className="text-xs text-status-error mt-1">{parsed.error}</p>}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="card divide-y divide-border-default" data-testid="caps">
        {!own && field('cap-team', 'Team', team, setTeam, perDay(defaultTeamUsd), teamParsed)}
        {field('cap-user', 'Each person', user, setUser, own ? 'No cap' : perDay(effectiveTeam * defaultUserShare), userParsed)}
      </div>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" data-testid="caps-save" onClick={save} disabled={busy || !loaded || !ok}>
            {busy ? 'Saving…' : 'Save caps'}
          </button>
          {msg && <span role="status" className={`text-xs ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>}
        </div>
      ) : (
        <p className="text-xs text-text-muted">Only a team owner or admin can change caps.</p>
      )}
    </div>
  );
}
