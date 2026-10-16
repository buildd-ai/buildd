'use client';

import { useState, useEffect } from 'react';
import { TOKEN_PRESETS, TOKEN_SCOPE_DEFINITIONS, type TokenScope } from '@buildd/core/token-scopes';
import { Select } from '@/components/ui/Select';
import ApiKeyModal from '@/components/ApiKeyModal';
import PrimaryAction from '@/components/ui/PrimaryAction';
import Notice from '@/components/ui/Notice';
import Sheet from '@/components/ui/Sheet';
import { useCloseUrlSheet } from '@/components/UrlSheet';
import { defaultTeamId, readActiveTeamCookie } from '@/lib/active-team-client';
import { roleHas } from '@/lib/permission-registry';

interface Team { id: string; name: string; slug: string; role: string }
interface Workspace { id: string; name: string; repo: string | null }
type Preset = keyof typeof TOKEN_PRESETS;
const inputClass = 'w-full min-h-11 px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm';

/**
 * Settings → Runners → New runner token, a sheet over Runners at `?new=1`
 * (was /app/settings/runners/tokens/new, and before that /app/accounts/new).
 * Once the token exists the sheet gives way to the key dialog; closing that
 * drops `?new` and the list behind shows the new token.
 */
export default function NewRunnerTokenSheet() {
  const close = useCloseUrlSheet(['new']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdAccount, setCreatedAccount] = useState<{ name: string; apiKey: string } | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [limited, setLimited] = useState(false);
  const [preset, setPreset] = useState<Preset>('runner');
  const [scopes, setScopes] = useState<TokenScope[]>([...TOKEN_PRESETS.runner.scopes]);
  const [expiry, setExpiry] = useState('30');
  const [customExpiry, setCustomExpiry] = useState('');
  const [accountType, setAccountType] = useState('user');
  const [maxConcurrent, setMaxConcurrent] = useState('5');
  const selectedTeam = teams.find(team => team.id === selectedTeamId);
  const canAdmin = roleHas(selectedTeam?.role, 'manage_team_keys');

  useEffect(() => {
    fetch('/api/teams').then(async res => {
      if (!res.ok) throw new Error('Could not load teams');
      const data = await res.json();
      setTeams(data.teams || []);
      setSelectedTeamId(defaultTeamId(data.teams || [], readActiveTeamCookie()) || '');
    }).catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    setWorkspaceIds([]);
    setWorkspaces([]);
    if (!selectedTeamId) return;
    const controller = new AbortController();
    fetch(`/api/workspaces?teamId=${encodeURIComponent(selectedTeamId)}`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error('Could not load workspaces');
        const data = await res.json();
        setWorkspaces(data.workspaces || []);
      }).catch(err => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [selectedTeamId]);

  function choosePreset(value: Preset) {
    setPreset(value);
    setScopes([...TOKEN_PRESETS[value].scopes]);
    setAccountType(value === 'ci' ? 'service' : 'user');
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    if (limited && workspaceIds.length === 0) { setError('Choose at least one workspace.'); return; }
    if (scopes.length === 0) { setError('Choose at least one scope.'); return; }
    const expiryDate = expiry === 'never' ? null : expiry === 'custom'
      ? new Date(customExpiry) : new Date(Date.now() + Number(expiry) * 86400000);
    if (expiryDate && (!Number.isFinite(expiryDate.getTime()) || expiryDate.getTime() <= Date.now())) { setError('Expiry must be in the future.'); return; }
    const expiresAt = expiryDate?.toISOString() ?? null;
    setLoading(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: new FormData(e.currentTarget).get('name'), type: accountType,
          level: scopes.includes('admin') ? 'admin' : 'worker',
          scopes, workspaceIds: limited ? workspaceIds : null, expiresAt,
          teamId: selectedTeamId, maxConcurrentWorkers: Number(maxConcurrent),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the token.');
      setCreatedAccount({ name: data.name, apiKey: data.apiKey });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the token.'); }
    finally { setLoading(false); }
  }

  // The key shows once: the dialog replaces the sheet so no Escape aimed at
  // the sheet can unmount it before the key is copied.
  if (createdAccount) {
    return <ApiKeyModal open accountName={createdAccount.name} apiKey={createdAccount.apiKey} onClose={close} />;
  }

  return (
    <Sheet open onClose={close} title="New runner token" height="tall" trapFocus testId="new-token-sheet">
        <form onSubmit={handleSubmit} className="space-y-8">
          {error && <Notice tone="err">{error}</Notice>}
          <div className="space-y-4">
            {teams.length > 1 && <div><label htmlFor="team" className="block text-sm mb-2">Team</label><Select id="team" value={selectedTeamId} onChange={id => { setSelectedTeamId(id); if (!roleHas(teams.find(team => team.id === id)?.role, 'manage_team_keys')) { setScopes(current => current.filter(scope => !scope.endsWith(':admin') && !['admin','secrets','releases','schedules:write'].includes(scope))); if (preset === 'admin') choosePreset('runner'); } }} options={teams.map(team => ({ value: team.id, label: team.name }))} /></div>}
            <div><label htmlFor="name" className="block text-sm mb-2">Token name</label><input id="name" name="name" required placeholder="release-ci" className={inputClass} /></div>
            {/* Radio rows: the chosen one is marked in ink, never orange. */}
            <fieldset><legend className="section-label mb-2">Preset</legend><div className="border-y border-border-default divide-y divide-border-default">
              {/* Only what this person may mint: the admin preset and scopes need manage_team_keys. */}
              {(Object.keys(TOKEN_PRESETS) as Preset[]).filter(key => key !== 'admin' || canAdmin).map(key => <label key={key} data-selected={preset === key ? 'true' : 'false'} className={`flex min-h-11 gap-3 py-3 pl-3 border-l-2 cursor-pointer ${preset === key ? 'border-l-text-primary' : 'border-l-transparent'}`}>
                <input type="radio" name="preset" className="mt-0.5 accent-[var(--text-primary)]" checked={preset === key} onChange={() => choosePreset(key)} />
                <span className="min-w-0"><span className={`block text-sm ${preset === key ? 'font-semibold text-text-primary' : 'font-medium text-text-primary'}`}>{TOKEN_PRESETS[key].label}</span>
                <span className="block mt-0.5 text-xs text-text-secondary">{TOKEN_PRESETS[key].description}</span></span>
              </label>)}
            </div></fieldset>
            <details><summary className="min-h-11 flex items-center cursor-pointer text-sm">Adjust scopes</summary><div className="divide-y divide-border-default">
              {TOKEN_SCOPE_DEFINITIONS.filter(def => canAdmin || !(def.scope.endsWith(':admin') || ['admin','secrets','releases','schedules:write'].includes(def.scope))).map(def => <label key={def.scope} className="flex gap-3 py-3 text-sm cursor-pointer">
                <input type="checkbox" className="mt-1" checked={scopes.includes(def.scope)} onChange={e => setScopes(current => e.target.checked ? [...current, def.scope] : current.filter(scope => scope !== def.scope))} />
                <span><span className="block">{def.label} <code className="text-xs text-text-muted">{def.scope}</code></span><span className="block text-xs text-text-secondary mt-1">{def.description}</span></span>
              </label>)}
            </div></details>
          </div>
          <div className="space-y-4">
            <fieldset><legend className="section-label mb-2">Workspaces</legend>
              <label className="flex items-center gap-2 min-h-11 text-sm"><input type="checkbox" checked={limited} onChange={e => setLimited(e.target.checked)} />Limit to selected workspaces</label>
              <p className="text-xs text-text-secondary">Access also requires the account to be linked to the workspace.</p>
              {limited && <div className="mt-2">{workspaces.length === 0 ? <p className="text-xs text-text-muted">No workspaces available in this team.</p> : workspaces.map(ws => <label key={ws.id} className="flex gap-2 items-center min-h-11 text-sm"><input type="checkbox" checked={workspaceIds.includes(ws.id)} onChange={e => setWorkspaceIds(current => e.target.checked ? [...current, ws.id] : current.filter(id => id !== ws.id))} />{ws.name}</label>)}</div>}
            </fieldset>
            <div><label htmlFor="expiry" className="block text-sm mb-2">Expiry</label><Select id="expiry" value={expiry} onChange={setExpiry} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'custom', label: 'Choose date and time' }, { value: 'never', label: 'No expiry' }]} />
              {expiry === 'custom' && <input aria-label="Expiry date and time" type="datetime-local" required value={customExpiry} onChange={e => setCustomExpiry(e.target.value)} className={`${inputClass} mt-2`} />}
            </div>
            <details><summary className="min-h-11 flex items-center text-sm cursor-pointer">Runner options</summary><div className="space-y-3"><label className="block text-sm">Account type<Select value={accountType} onChange={setAccountType} options={[{ value: 'user', label: 'Personal runner' }, { value: 'service', label: 'Always-on service' }]} /></label><label className="block text-sm">Concurrent workers<input type="number" min="1" max="10" required value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)} className={inputClass} /></label></div></details>
          </div>
          <section aria-label="Permission preview" className="card p-4">
            {limited && <p className="text-xs text-text-secondary mb-3">Workspace restrictions also apply to admin access. Team-wide credentials, account administration and reports without workspace filters are unavailable.</p>}
            <h2 className="section-label mb-3">This token can</h2>
            {scopes.length === 0 ? <p className="text-sm text-text-muted">No scopes. Choose at least one.</p> : <ul className="space-y-2 text-sm">{TOKEN_SCOPE_DEFINITIONS.filter(def => scopes.includes(def.scope)).map(def => <li key={def.scope}><span className="font-medium">{def.label}</span><span className="block text-xs text-text-secondary">{def.description}</span></li>)}</ul>}
            <p className="text-xs text-text-secondary mt-4">{limited ? (workspaceIds.length ? `Restricted to ${workspaces.filter(ws => workspaceIds.includes(ws.id)).map(ws => ws.name).join(', ')}.` : 'Choose at least one workspace.') : 'Available in all linked workspaces.'}</p>
            <p className="text-xs text-text-secondary mt-2">{expiry === 'never' ? 'Does not expire.' : expiry === 'custom' ? `Expires ${customExpiry || 'on your selected date'}.` : `Expires ${expiry} days after creation.`}</p>
          </section>
          <div className="flex items-center gap-3"><PrimaryAction type="submit" pending={loading} disabled={!selectedTeamId || !scopes.length || (scopes.includes('admin') && !canAdmin)} fullWidthOnMobile>{loading ? 'Creating…' : 'Create token'}</PrimaryAction><button type="button" onClick={close} className="btn min-h-11 md:min-h-0">Cancel</button></div>
        </form>
    </Sheet>
  );
}
