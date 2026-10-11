'use client';
import { useEffect, useState } from 'react';
import { isWarmHandover, type WarmHandover } from '@buildd/shared';
import { Select } from '@/components/ui/Select';

const COPY: Record<WarmHandover, string> = {
  off: 'Each task starts from a clean copy of the repository.',
  repo: 'Reuse the repository; clear dependencies between tasks.',
  deps: 'Reuse the repository and verified dependencies between tasks.',
};
type Choice = WarmHandover | 'inherit';
export default function WarmHandoverSection({ teamId, workspaceId, initial = null, canEdit = true }: {
  teamId?: string; workspaceId?: string; initial?: WarmHandover | null; canEdit?: boolean;
}) {
  const [value, setValue] = useState<Choice>(initial ?? (workspaceId ? 'inherit' : 'off'));
  const [teamMode, setTeamMode] = useState<WarmHandover>('off');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!teamId) return;
    let active = true;
    fetch(`/api/teams/${teamId}`).then(async res => {
      if (!res.ok) throw new Error('Failed to load warm handover');
      const data = await res.json();
      if (active && isWarmHandover(data.team?.warmHandover)) {
        setTeamMode(data.team.warmHandover);
        if (!workspaceId) setValue(data.team.warmHandover);
      }
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [teamId, workspaceId]);
  async function save(next: Choice) {
    setSaving(true); setError(null);
    try {
      const mode = next === 'inherit' ? null : next;
      const res = await fetch(workspaceId ? `/api/workspaces/${workspaceId}` : `/api/teams/${teamId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workspaceId ? { gitConfig: { warmHandover: mode } } : { warmHandover: mode }),
      });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Failed to save'); }
      setValue(next);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save'); }
    finally { setSaving(false); }
  }
  const modes: WarmHandover[] = ['off', 'repo', 'deps'];
  const options: Array<{ value: Choice; label: string }> = [
    ...(workspaceId ? [{ value: 'inherit' as const, label: 'Team default' }] : []),
    { value: 'off', label: 'Off' }, { value: 'repo', label: 'Repository' }, { value: 'deps', label: 'Verified dependencies' },
  ];
  return <section className="mt-10">
    <h2 className="section-label mb-3">Warm handover</h2>
    <div className="card p-4 space-y-3">
      <Select<Choice> value={value} options={options} onChange={save} disabled={saving || !canEdit}
        aria-label="Warm handover" testId="warm-handover-select" />
      {modes.map(mode => <p key={mode} className="text-body text-text-secondary">{options.find(option => option.value === mode)?.label}: {COPY[mode]}</p>)}
      {workspaceId && value === 'inherit' && <p className="text-meta text-text-muted">Team default: {options.find(option => option.value === teamMode)?.label}</p>}
      {error && <p role="alert" className="text-body text-status-error">{error}</p>}
    </div>
  </section>;
}
