'use client';

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { MODEL_OPTIONS } from '@/lib/config-helpers';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface MissionConfigProps {
  missionId: string;
  workspaceId: string | null;
  skillSlugs: string[];
  model: string | null;
  workspaces: WorkspaceOption[];
}

export default function MissionConfig({
  missionId,
  workspaceId,
  skillSlugs: initialSkillSlugs,
  model: initialModel,
  workspaces,
}: MissionConfigProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Skills state
  const [skillSlugs, setSkillSlugs] = useState<string[]>(initialSkillSlugs);
  const [newSkill, setNewSkill] = useState('');
  const [showSkillInput, setShowSkillInput] = useState(false);

  // Model state
  const [model, setModel] = useState(initialModel || '');

  // Workspace state
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || '');

  const disabled = saving !== null || isPending;

  const patchMission = useCallback(async (body: Record<string, unknown>, field: string) => {
    setSaving(field);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        startTransition(() => router.refresh());
      }
    } finally {
      setSaving(null);
    }
  }, [missionId, router]);

  function handleAddSkill() {
    const slug = newSkill.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '');
    if (!slug || skillSlugs.includes(slug)) {
      setNewSkill('');
      return;
    }
    const updated = [...skillSlugs, slug];
    setSkillSlugs(updated);
    setNewSkill('');
    setShowSkillInput(false);
    patchMission({ skillSlugs: updated }, 'skills');
  }

  function handleRemoveSkill(slug: string) {
    const updated = skillSlugs.filter((s: string) => s !== slug);
    setSkillSlugs(updated);
    patchMission({ skillSlugs: updated }, 'skills');
  }

  function handleModelChange(value: string) {
    setModel(value);
    patchMission({ model: value || null }, 'model');
  }

  function handleWorkspaceChange(value: string) {
    setSelectedWorkspaceId(value);
    patchMission({ workspaceId: value || null }, 'workspace');
  }

  const workspaceOptions = [
    { value: '', label: 'No workspace' },
    ...workspaces.map(ws => ({ value: ws.id, label: ws.name })),
  ];

  // Summarize what's configured for the collapsed view
  const configSummary = [
    model && MODEL_OPTIONS.find(m => m.value === model)?.label,
    skillSlugs.length > 0 && `${skillSlugs.length} skill${skillSlugs.length > 1 ? 's' : ''}`,
  ].filter(Boolean);

  return (
    <div className="card p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <h2 className="section-label">Configuration</h2>
          {!expanded && configSummary.length > 0 && (
            <span className="text-[11px] text-text-muted">{configSummary.join(' · ')}</span>
          )}
        </div>
        <svg className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Workspace */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Workspace</label>
            <div className="max-w-xs">
              <Select
                value={selectedWorkspaceId}
                onChange={handleWorkspaceChange}
                options={workspaceOptions}
                placeholder="No workspace"
                size="sm"
                disabled={disabled}
              />
            </div>
            {selectedWorkspaceId !== (workspaceId || '') && (
              <p className="text-[11px] text-status-warning mt-1">
                Changing workspace will update where scheduled tasks run.
              </p>
            )}
          </div>

          {/* Model */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Model</label>
            <div className="max-w-xs">
              <Select
                value={model}
                onChange={handleModelChange}
                options={MODEL_OPTIONS}
                placeholder="Default"
                size="sm"
                disabled={disabled}
              />
            </div>
          </div>

          {/* Skills */}
          <div>
            <label className="block text-[11px] text-text-muted mb-1.5">Skills</label>
            <div className="flex flex-wrap gap-1.5 items-center">
              {skillSlugs.map((slug: string) => (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1 text-[11px] bg-accent/10 text-accent-text px-2 py-0.5 rounded-full"
                >
                  {slug}
                  <button
                    type="button"
                    onClick={() => handleRemoveSkill(slug)}
                    disabled={disabled}
                    className="hover:text-status-error disabled:opacity-50 ml-0.5"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {showSkillInput ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={newSkill}
                    onChange={e => setNewSkill(e.target.value)}
                    placeholder="skill-slug"
                    className="w-32 px-2 py-0.5 bg-surface-3 border border-card-border rounded-lg text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/40 font-mono"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleAddSkill();
                      if (e.key === 'Escape') { setNewSkill(''); setShowSkillInput(false); }
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddSkill}
                    disabled={disabled || !newSkill.trim()}
                    className="px-1.5 py-0.5 text-[11px] font-medium bg-accent/20 text-accent-text rounded-lg hover:bg-accent/30 disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => { setNewSkill(''); setShowSkillInput(false); }}
                    className="px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSkillInput(true)}
                  disabled={disabled}
                  className="text-[11px] text-accent-text hover:text-accent-text/80 disabled:opacity-50"
                >
                  + Add skill
                </button>
              )}
            </div>
            {skillSlugs.length === 0 && !showSkillInput && (
              <p className="text-[11px] text-text-muted mt-1">No skills configured.</p>
            )}
          </div>

          {saving && (
            <p className="text-[11px] text-text-muted animate-pulse">Saving {saving}...</p>
          )}
        </div>
      )}
    </div>
  );
}
