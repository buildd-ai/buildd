'use client';

import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { MODEL_OPTIONS } from './config-helpers';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface ObjectiveConfigProps {
  objectiveId: string;
  workspaceId: string | null;
  workspace: { id: string; name: string } | null;
  skillSlugs: string[];
  recipeId: string | null;
  model: string | null;
  outputSchema: unknown | null;
  workspaces: WorkspaceOption[];
}

export default function ObjectiveConfig({
  objectiveId,
  workspaceId,
  workspace,
  skillSlugs: initialSkillSlugs,
  recipeId: initialRecipeId,
  model: initialModel,
  outputSchema: initialOutputSchema,
  workspaces,
}: ObjectiveConfigProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saving, setSaving] = useState<string | null>(null);

  // Skills state
  const [skillSlugs, setSkillSlugs] = useState<string[]>(initialSkillSlugs);
  const [newSkill, setNewSkill] = useState('');
  const [showSkillInput, setShowSkillInput] = useState(false);

  // Recipe state
  const [recipeId, setRecipeId] = useState(initialRecipeId || '');
  const [editingRecipe, setEditingRecipe] = useState(false);

  // Model state
  const [model, setModel] = useState(initialModel || '');

  // Output schema state
  const [outputSchemaStr, setOutputSchemaStr] = useState(
    initialOutputSchema ? JSON.stringify(initialOutputSchema, null, 2) : ''
  );
  const [editingSchema, setEditingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaExpanded, setSchemaExpanded] = useState(false);

  // Workspace state
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || '');

  const disabled = saving !== null || isPending;

  const patchObjective = useCallback(async (body: Record<string, unknown>, field: string) => {
    setSaving(field);
    try {
      const res = await fetch(`/api/missions/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        startTransition(() => router.refresh());
      }
    } finally {
      setSaving(null);
    }
  }, [objectiveId, router]);

  // Skills handlers
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
    patchObjective({ skillSlugs: updated }, 'skills');
  }

  function handleRemoveSkill(slug: string) {
    const updated = skillSlugs.filter((s: string) => s !== slug);
    setSkillSlugs(updated);
    patchObjective({ skillSlugs: updated }, 'skills');
  }

  // Recipe handler
  function handleSaveRecipe() {
    const trimmed = recipeId.trim();
    patchObjective({ recipeId: trimmed || null }, 'recipe');
    setEditingRecipe(false);
  }

  // Model handler
  function handleModelChange(value: string) {
    setModel(value);
    patchObjective({ model: value || null }, 'model');
  }

  // Output schema handler
  function handleSaveSchema() {
    const trimmed = outputSchemaStr.trim();
    if (!trimmed) {
      setSchemaError(null);
      patchObjective({ outputSchema: null }, 'schema');
      setEditingSchema(false);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      setSchemaError(null);
      setOutputSchemaStr(JSON.stringify(parsed, null, 2));
      patchObjective({ outputSchema: parsed }, 'schema');
      setEditingSchema(false);
    } catch {
      setSchemaError('Invalid JSON');
    }
  }

  // Workspace handler
  function handleWorkspaceChange(value: string) {
    setSelectedWorkspaceId(value);
    patchObjective({ workspaceId: value || null }, 'workspace');
  }

  const workspaceOptions = [
    { value: '', label: 'No workspace' },
    ...workspaces.map(ws => ({ value: ws.id, label: ws.name })),
  ];

  return (
    <div className="mb-6 p-4 bg-surface-2 rounded-lg border border-border-default">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Configuration</h2>

      <div className="space-y-4">
        {/* Workspace */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">Workspace</label>
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
            <p className="text-xs text-status-warning mt-1">
              Changing workspace will update where scheduled tasks run.
            </p>
          )}
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">Model</label>
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
          <label className="block text-xs text-text-muted mb-1.5">Skills</label>
          <div className="flex flex-wrap gap-1.5 items-center">
            {skillSlugs.map((slug: string) => (
              <span
                key={slug}
                className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full"
              >
                {slug}
                <button
                  type="button"
                  onClick={() => handleRemoveSkill(slug)}
                  disabled={disabled}
                  className="hover:text-status-error disabled:opacity-50 ml-0.5"
                  title="Remove skill"
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
                  className="w-32 px-2 py-0.5 bg-surface-1 border border-border-default rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
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
                  className="px-1.5 py-0.5 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => { setNewSkill(''); setShowSkillInput(false); }}
                  className="px-1.5 py-0.5 text-xs text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowSkillInput(true)}
                disabled={disabled}
                className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
              >
                + Add skill
              </button>
            )}
          </div>
          {skillSlugs.length === 0 && !showSkillInput && (
            <p className="text-xs text-text-muted mt-1">No skills configured.</p>
          )}
        </div>

        {/* Recipe */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">Recipe</label>
          {editingRecipe ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={recipeId}
                onChange={e => setRecipeId(e.target.value)}
                placeholder="Recipe ID"
                className="flex-1 max-w-xs px-2 py-1 bg-surface-1 border border-border-default rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveRecipe();
                  if (e.key === 'Escape') { setRecipeId(initialRecipeId || ''); setEditingRecipe(false); }
                }}
              />
              <button
                type="button"
                onClick={handleSaveRecipe}
                disabled={disabled}
                className="px-2 py-1 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => { setRecipeId(initialRecipeId || ''); setEditingRecipe(false); }}
                className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              {initialRecipeId && (
                <button
                  type="button"
                  onClick={() => { setRecipeId(''); handleSaveRecipe(); }}
                  disabled={disabled}
                  className="px-2 py-1 text-xs text-status-error hover:text-status-error/80 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {initialRecipeId ? (
                <span className="text-xs text-text-primary font-mono">{initialRecipeId}</span>
              ) : (
                <span className="text-xs text-text-muted">None</span>
              )}
              <button
                type="button"
                onClick={() => setEditingRecipe(true)}
                disabled={disabled}
                className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
              >
                {initialRecipeId ? 'Edit' : 'Set recipe'}
              </button>
            </div>
          )}
        </div>

        {/* Output Schema */}
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-xs text-text-muted">Output Schema</label>
            {outputSchemaStr && !editingSchema && (
              <button
                type="button"
                onClick={() => setSchemaExpanded(!schemaExpanded)}
                className="text-xs text-text-secondary hover:text-text-primary"
              >
                {schemaExpanded ? 'Collapse' : 'Expand'}
              </button>
            )}
          </div>
          {editingSchema ? (
            <div className="space-y-2">
              <textarea
                value={outputSchemaStr}
                onChange={e => { setOutputSchemaStr(e.target.value); setSchemaError(null); }}
                placeholder='{"type": "object", "properties": { ... }}'
                rows={8}
                className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-y"
              />
              {schemaError && (
                <p className="text-xs text-status-error">{schemaError}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveSchema}
                  disabled={disabled}
                  className="px-2 py-1 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOutputSchemaStr(initialOutputSchema ? JSON.stringify(initialOutputSchema, null, 2) : '');
                    setSchemaError(null);
                    setEditingSchema(false);
                  }}
                  className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                {initialOutputSchema != null && (
                  <button
                    type="button"
                    onClick={() => {
                      setOutputSchemaStr('');
                      setSchemaError(null);
                      patchObjective({ outputSchema: null }, 'schema');
                      setEditingSchema(false);
                    }}
                    disabled={disabled}
                    className="px-2 py-1 text-xs text-status-error hover:text-status-error/80 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div>
              {outputSchemaStr ? (
                <>
                  <pre
                    className={`text-xs text-text-secondary bg-surface-3 p-2 rounded overflow-x-auto font-mono ${
                      schemaExpanded ? '' : 'max-h-20'
                    } overflow-hidden`}
                  >
                    {outputSchemaStr}
                  </pre>
                  <button
                    type="button"
                    onClick={() => setEditingSchema(true)}
                    disabled={disabled}
                    className="text-xs text-primary hover:text-primary/80 disabled:opacity-50 mt-1"
                  >
                    Edit
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">None</span>
                  <button
                    type="button"
                    onClick={() => setEditingSchema(true)}
                    disabled={disabled}
                    className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
                  >
                    Add schema
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Saving indicator */}
      {saving && (
        <p className="text-xs text-text-muted mt-3 animate-pulse">
          Saving {saving}...
        </p>
      )}
    </div>
  );
}
