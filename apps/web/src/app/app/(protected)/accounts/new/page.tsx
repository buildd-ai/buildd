'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TOKEN_PRESETS, TOKEN_SCOPE_DEFINITIONS, type TokenScope } from '@buildd/core/token-scopes';
import { Select } from '@/components/ui/Select';
import ApiKeyModal from '@/components/ApiKeyModal';
import { defaultTeamId, readActiveTeamCookie } from '@/lib/active-team-client';

interface Team { id: string; name: string; slug: string; role: string }
interface Workspace { id: string; name: string; repo: string | null }
type Preset = keyof typeof TOKEN_PRESETS;
const inputClass = 'w-full min-h-11 px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm';

export default function NewAccountPage() {
  const router = useRouter();
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
  const canAdmin = selectedTeam?.role === 'owner' || selectedTeam?.role === 'admin';

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
    setAccountType(value === 'ci' ? 'action' : 'user');
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
      if (!res.ok) throw new Error(data.error || 'Failed to create token');
      setCreatedAccount({ name: data.name, apiKey: data.apiKey });
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create token'); }
    finally { setLoading(false); }
  }

  return (
    <main className="min-h-screen pt-14 px-4 pb-8 md:p-8 font-mono">
      <div className="max-w-2xl mx-auto">
        <Link href="/app/settings/runners" className="text-sm text-text-secondary hover:text-text-primary block mb-4">&larr; Tokens</Link>
        <h1 className="text-2xl font-semibold">New token</h1>
        <p className="text-sm text-text-secondary mt-2 mb-6">Choose the access this token needs. Review its permissions before creating it.</p>
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <p role="alert" className="border border-status-error p-3 text-sm text-status-error">{error}</p>}
          <div className="card p-4 space-y-4">
            {teams.length > 1 && <div><label htmlFor="team" className="block text-sm mb-2">Team</label><Select id="team" value={selectedTeamId} onChange={id => { setSelectedTeamId(id); if (!['owner', 'admin'].includes(teams.find(team => team.id === id)?.role || '')) { setScopes(current => current.filter(scope => !scope.endsWith(':admin') && !['admin','secrets','releases','schedules:write'].includes(scope))); if (preset === 'admin') choosePreset('runner'); } }} options={teams.map(team => ({ value: team.id, label: team.name }))} /></div>}
            <div><label htmlFor="name" className="block text-sm mb-2">Token name</label><input id="name" name="name" required placeholder="release-ci" className={inputClass} /></div>
            <fieldset><legend className="section-label mb-3">Preset</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(Object.keys(TOKEN_PRESETS) as Preset[]).map(key => <label key={key} className={`min-h-11 p-3 border cursor-pointer ${preset === key ? 'border-primary bg-surface-3' : 'border-border-default'} ${key === 'admin' && !canAdmin ? 'opacity-50' : ''}`}>
                <span className="flex gap-2 items-center text-sm font-medium"><input type="radio" name="preset" checked={preset === key} disabled={key === 'admin' && !canAdmin} onChange={() => choosePreset(key)} />{TOKEN_PRESETS[key].label}</span>
                <span className="block mt-2 text-xs text-text-secondary">{TOKEN_PRESETS[key].description}</span>
              </label>)}
            </div></fieldset>
            <details><summary className="min-h-11 flex items-center cursor-pointer text-sm">Adjust scopes</summary><div className="divide-y divide-border-default">
              {TOKEN_SCOPE_DEFINITIONS.map(def => <label key={def.scope} className="flex gap-3 py-3 text-sm cursor-pointer">
                <input type="checkbox" className="mt-1" checked={scopes.includes(def.scope)} disabled={(def.scope.endsWith(':admin') || ['admin','secrets','releases','schedules:write'].includes(def.scope)) && !canAdmin} onChange={e => setScopes(current => e.target.checked ? [...current, def.scope] : current.filter(scope => scope !== def.scope))} />
                <span><span className="block">{def.label} <code className="text-xs text-text-muted">{def.scope}</code></span><span className="block text-xs text-text-secondary mt-1">{def.description}</span></span>
              </label>)}
            </div></details>
          </div>
          <div className="card p-4 space-y-4">
            <fieldset><legend className="section-label mb-2">Workspaces</legend>
              <label className="flex items-center gap-2 min-h-11 text-sm"><input type="checkbox" checked={limited} onChange={e => setLimited(e.target.checked)} />Limit to selected workspaces</label>
              <p className="text-xs text-text-secondary">Access also requires the account to be linked to the workspace.</p>
              {limited && <div className="mt-2">{workspaces.length === 0 ? <p className="text-xs text-text-muted">No workspaces available in this team.</p> : workspaces.map(ws => <label key={ws.id} className="flex gap-2 items-center min-h-11 text-sm"><input type="checkbox" checked={workspaceIds.includes(ws.id)} onChange={e => setWorkspaceIds(current => e.target.checked ? [...current, ws.id] : current.filter(id => id !== ws.id))} />{ws.name}</label>)}</div>}
            </fieldset>
            <div><label htmlFor="expiry" className="block text-sm mb-2">Expiry</label><Select id="expiry" value={expiry} onChange={setExpiry} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'custom', label: 'Choose date and time' }, { value: 'never', label: 'No expiry' }]} />
              {expiry === 'custom' && <input aria-label="Expiry date and time" type="datetime-local" required value={customExpiry} onChange={e => setCustomExpiry(e.target.value)} className={`${inputClass} mt-2`} />}
            </div>
            <details><summary className="min-h-11 flex items-center text-sm cursor-pointer">Runner options</summary><div className="space-y-3"><label className="block text-sm">Account type<Select value={accountType} onChange={setAccountType} options={[{ value: 'user', label: 'Personal runner' }, { value: 'service', label: 'Always-on service' }, { value: 'action', label: 'GitHub Actions' }]} /></label><label className="block text-sm">Concurrent workers<input type="number" min="1" max="10" required value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)} className={inputClass} /></label></div></details>
          </div>
          <section aria-label="Permission preview" className="card p-4">
            {limited && <p className="text-xs text-text-secondary mb-3">Workspace restrictions also apply to admin access. Team-wide credentials, account administration and reports without workspace filters are unavailable.</p>}
            <h2 className="section-label mb-3">This token can</h2>
            {scopes.length === 0 ? <p className="text-sm text-text-muted">No capabilities selected.</p> : <ul className="space-y-2 text-sm">{TOKEN_SCOPE_DEFINITIONS.filter(def => scopes.includes(def.scope)).map(def => <li key={def.scope}><span className="font-medium">{def.label}</span><span className="block text-xs text-text-secondary">{def.description}</span></li>)}</ul>}
            <p className="text-xs text-text-secondary mt-4">{limited ? `Restricted to ${workspaceIds.length ? workspaces.filter(ws => workspaceIds.includes(ws.id)).map(ws => ws.name).join(', ') : 'no workspaces selected'}.` : 'Available in all linked workspaces.'}</p>
            <p className="text-xs text-text-secondary mt-2">{expiry === 'never' ? 'Does not expire.' : expiry === 'custom' ? `Expires ${customExpiry || 'on your selected date'}.` : `Expires ${expiry} days after creation.`}</p>
          </section>
          <div className="flex gap-3"><button type="submit" disabled={loading || !selectedTeamId || !scopes.length || (scopes.includes('admin') && !canAdmin)} className="btn btn-primary flex-1 min-h-11">{loading ? 'Creating…' : 'Create token'}</button><Link href="/app/settings/runners" className="btn min-h-11">Cancel</Link></div>
        </form>
      </div>
      {createdAccount && <ApiKeyModal open accountName={createdAccount.name} apiKey={createdAccount.apiKey} onClose={() => { setCreatedAccount(null); router.push('/app/settings/runners'); }} />}
    </main>
  );
}
