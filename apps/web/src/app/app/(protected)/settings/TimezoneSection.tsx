'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Section from '@/components/ui/Section';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-options';
import { Select } from '@/components/ui/Select';
import { roleHas } from '@/lib/permission-registry';

interface Team {
  id: string;
  name: string;
}

/**
 * The team's canonical working zone.
 *
 * Your own zone is detected from the browser and never asked for; this setting
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
      setCanEdit(roleHas(data.currentUserRole, 'manage_team_settings', data.team?.permissionOverrides ?? null));
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

  const status = (
    <>
      {stored === null ? 'Not set. buildd uses UTC.' : `Set to ${stored}.`}
      {preview && <> It is <span className="font-mono">{preview}</span> there now.</>}
    </>
  );

  return (
    <Section
      title="Timezone"
      action={!loading && !canEdit ? <span data-testid="timezone-read-only" className="text-xs text-text-muted">Admins can change this.</span> : undefined}
    >
      {/* One fact, one select: an L1 row on a hairline, never a card. */}
      <div className="divide-y divide-border-default border-y border-border-default">
        {teams.length > 1 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 py-3">
            <span className="text-sm text-text-primary">Team</span>
            <div className="sm:w-64">
              <Select
                aria-label="Team"
                value={selectedTeamId}
                onChange={setSelectedTeamId}
                options={teams.map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 py-3" data-testid="team-timezone-row">
          <div className="min-w-0">
            <span className="block text-sm text-text-primary">Team timezone</span>
            <span className="block text-xs text-text-secondary mt-0.5">
              For pull request comments, new schedules and mission active hours.
            </span>
            {!loading && <span className="block text-xs text-text-muted mt-0.5">{status}</span>}
          </div>
          <div className="sm:w-64 shrink-0">
            {loading ? (
              <p className="text-sm text-text-muted">Loading…</p>
            ) : (
              <Select
                aria-label="Team timezone"
                value={draft}
                disabled={!canEdit || busy}
                onChange={setDraft}
                searchable
                options={zones.map((z) => ({ value: z, label: z }))}
              />
            )}
          </div>
        </div>
      </div>

      {!loading && canEdit && (draft !== (stored ?? '') || (detected !== stored && detected !== draft)) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {draft !== (stored ?? '') && (
            <button onClick={() => save(draft)} disabled={busy} className="btn btn-sm">
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
          {/* When the picker already shows this browser's zone, Save does the same thing. */}
          {detected !== stored && detected !== draft && (
            <button onClick={() => save(detected)} disabled={busy} className="btn btn-sm btn-quiet">
              Use mine ({detected})
            </button>
          )}
        </div>
      )}

      {msg && (
        <p role={msg.type === 'error' ? 'alert' : 'status'} className={`mt-2 text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
          {msg.text}
        </p>
      )}
    </Section>
  );
}
