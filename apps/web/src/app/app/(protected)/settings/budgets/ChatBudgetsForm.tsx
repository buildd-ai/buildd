'use client';

import { useEffect, useState } from 'react';
import { budgetFromApi, parseBudgetInput } from './budget-input';

/**
 * Daily chat spend caps (`teams.chatDailyBudgetUsd`, `chatUserDailyBudgetUsd`).
 * Empty means the default; the server resolves it (lib/chat/limits.ts).
 */
export default function ChatBudgetsForm({
  teamId, canManage, defaultTeamUsd, defaultUserShare,
}: {
  teamId: string;
  canManage: boolean;
  defaultTeamUsd: number;
  /** Fraction of the team budget one person may spend when no per-person cap is set. */
  defaultUserShare: number;
}) {
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
        setTeam(t === null ? '' : String(t));
        setUser(u === null ? '' : String(u));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [teamId]);

  const teamParsed = parseBudgetInput(team);
  const userParsed = parseBudgetInput(user);
  const effectiveTeam = teamParsed.ok && teamParsed.value !== null ? teamParsed.value : defaultTeamUsd;
  const userPlaceholder = (effectiveTeam * defaultUserShare).toFixed(2).replace(/\.00$/, '');

  async function save() {
    if (!teamParsed.ok || !userParsed.ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatDailyBudgetUsd: teamParsed.value, chatUserDailyBudgetUsd: userParsed.value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save the budgets.');
      setMsg({ tone: 'ok', text: 'Budgets saved.' });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save the budgets.' });
    } finally {
      setBusy(false);
    }
  }

  const field = (
    id: string, label: string, hint: string, value: string, set: (v: string) => void, placeholder: string,
    parsed: ReturnType<typeof parseBudgetInput>,
  ) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-muted" aria-hidden>$</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={placeholder}
          disabled={!canManage || !loaded}
          className="w-32 h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-sm disabled:opacity-60"
        />
        <span className="text-xs text-text-muted">a day</span>
      </div>
      <p className="text-xs text-text-secondary">{hint}</p>
      {!parsed.ok && <p className="text-xs text-status-error">{parsed.error}</p>}
    </div>
  );

  return (
    <div className="card p-4 space-y-5" data-testid="chat-budgets">
      {field('chat-team-budget', 'Team', `Leave empty for the default, $${defaultTeamUsd}. Chat stops for everyone when the team reaches it, and starts again at midnight team time.`, team, setTeam, String(defaultTeamUsd), teamParsed)}
      {field('chat-user-budget', 'Each person', `Leave empty and each person gets ${Math.round(defaultUserShare * 100)}% of the team budget. A per-person cap above the team budget has no effect.`, user, setUser, userPlaceholder, userParsed)}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={save} disabled={busy || !loaded || !teamParsed.ok || !userParsed.ok}>
            {busy ? 'Saving…' : 'Save budgets'}
          </button>
          {msg && (
            <span role="status" className={`text-xs ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>
          )}
        </div>
      ) : (
        <p className="text-xs text-text-muted">Only a team owner or admin can change budgets.</p>
      )}
    </div>
  );
}
