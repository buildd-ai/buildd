'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import SettingsSection from './SettingsSection';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-options';

interface Team {
  id: string;
  name: string;
}

/**
 * The team's canonical working zone.
 *
 * Your own zone is detected from the browser and never asked for — this setting
 * exists for the other half: artifacts nobody "views" from a session, like the PR
 * activity comment buildd posts on GitHub, the default zone for new schedules, and
 * mission active hours. Those need one agreed wall clock, and it should be the
 * team's, not whoever happened to sign in first.
 */
export default function TimezoneSection({ teams, currentTeamId }: { teams: Team[]; currentTeamId: string | null }) {
  const [selectedTeamId, setSelectedTeamId] = useState<string>(currentTeamId || teams[0]?.id || '');
  const [stored, setStored] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('UTC');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  // Every zone this browser knows, so nobody in Toronto has to pick "Eastern".
  // Falls back to the curated shortlist on a runtime without supportedValuesOf.
  const zones = useMemo(() => {
    let all: string[];
    try {
      all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      all = [];
    }
    if (all.length === 0) all = TIMEZONE_OPTIONS.map((o) => o.value);
    return Array.from(new Set(['UTC', detected, draft, ...all].filter(Boolean))).sort();
  }, [detected, draft]);

  const load = useCallback(async (teamId: string) => {
    if (!teamId) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (!res.ok) throw new Error('Failed to load team');
      const data = await res.json();
      setStored(data.team?.timezone ?? null);
      setDraft(data.team?.timezone ?? detected);
      setCanEdit(data.currentUserRole === 'owner' || data.currentUserRole === 'admin');
    } catch {
      setMsg({ type: 'error', text: 'Failed to load the team timezone' });
    } finally {
      setLoading(false);
    }
  }, [detected]);

  useEffect(() => {
    void load(selectedTeamId);
  }, [selectedTeamId, load]);

  async function save(timezone: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${selectedTeamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setStored(timezone);
      setDraft(timezone);
      setMsg({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setBusy(false);
    }
  }

  // Concrete beats abstract: show what the clock actually reads there right now.
  const preview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: draft,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      }).format(new Date());
    } catch {
      return null;
    }
  }, [draft]);

  if (teams.length === 0) return null;

  return (
    <SettingsSection title="Timezone">
      <p className="text-sm text-text-secondary">
        The wall clock buildd uses for anything it writes outside the dashboard — timestamps in the
        activity comment it posts on your pull requests, the default zone for new schedules, and
        mission active hours. Your own dashboard already follows{' '}
        <span className="font-mono text-xs">{detected}</span>, detected from this browser.
      </p>

      {teams.length > 1 && (
        <label className="block">
          <span className="field-label">Team</span>
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="w-full h-10 px-3 bg-surface text-sm"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      )}

      {loading ? (
        <div className="text-sm text-text-tertiary">Loading…</div>
      ) : (
        <>
          <label className="block">
            <span className="field-label">Team timezone</span>
            <select
              value={draft}
              disabled={!canEdit || busy}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full h-10 px-3 bg-surface text-sm"
            >
              {zones.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </label>

          <div className="text-xs text-text-tertiary">
            {stored === null
              ? 'Not set — buildd is using UTC.'
              : `Currently ${stored}.`}
            {preview && <> It is <span className="font-mono">{preview}</span> there now.</>}
          </div>

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => save(draft)}
                disabled={busy || draft === (stored ?? '')}
                className="btn btn-primary"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              {detected !== stored && (
                <button onClick={() => save(detected)} disabled={busy} className="btn btn-quiet">
                  Use mine ({detected})
                </button>
              )}
            </div>
          ) : (
            <div className="text-xs text-text-tertiary">Only team owners and admins can change this.</div>
          )}
        </>
      )}

      {msg && (
        <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
          {msg.text}
        </div>
      )}
    </SettingsSection>
  );
}
