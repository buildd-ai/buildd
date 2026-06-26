'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';

const MODEL_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'opus', label: 'Claude Opus 4' },
  { value: 'sonnet', label: 'Claude Sonnet 4' },
  { value: 'haiku', label: 'Claude Haiku 4.5' },
] as const;

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit',
];

const COLOR_PALETTE = [
  '#D4724A', '#5B7BB3', '#6B8E5E', '#C4963B',
  '#9B59B6', '#2C8C99', '#D4A24A', '#8A8478',
];

interface WorkspaceOption {
  id: string;
  name: string;
}

interface Props {
  teamId: string;
  workspaces: WorkspaceOption[];
}

type Scope = 'team' | 'workspace';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function TeamRoleForm({ teamId, workspaces }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scope
  const [scope, setScope] = useState<Scope>('team');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>(workspaces[0]?.id || '');

  // Role fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('inherit');
  const [defaultBackend, setDefaultBackend] = useState<BackendValue>(null);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>([]);
  const [background, setBackground] = useState(false);
  const [maxTurns, setMaxTurns] = useState('');
  const [color, setColor] = useState(COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugManual) setSlug(slugify(value));
  }

  const toggleTool = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      let res: Response;

      if (scope === 'team') {
        // Create a team-level role
        res = await fetch('/api/roles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            slug: slug || undefined,
            description: description || undefined,
            content,
            model,
            defaultBackend,
            allowedTools,
            canDelegateTo,
            background,
            maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
            color,
            isRole: true,
          }),
        });
      } else {
        // Create a workspace-scoped role
        if (!targetWorkspaceId) throw new Error('Select a workspace');
        res = await fetch(`/api/workspaces/${targetWorkspaceId}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            slug: slug || undefined,
            description: description || undefined,
            content,
            model,
            defaultBackend,
            allowedTools,
            canDelegateTo,
            background,
            maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
            color,
            isRole: true,
          }),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create role');
      }

      router.push('/app/team');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-text-primary mb-1">New Role</h1>
        <p className="text-sm text-text-muted">Define an agent persona with a model, tools, and instructions.</p>
      </div>

      {/* Scope selector */}
      <div className="border border-border-default rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-medium text-text-secondary">Applies to</span>
        </div>
        <div className="flex rounded-md border border-border-default overflow-hidden w-fit">
          <button
            type="button"
            onClick={() => setScope('team')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              scope === 'team'
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            All workspaces in team
          </button>
          {workspaces.length > 0 && (
            <button
              type="button"
              onClick={() => setScope('workspace')}
              className={`px-4 py-2 text-sm font-medium border-l border-border-default transition-colors ${
                scope === 'workspace'
                  ? 'bg-surface-3 text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              One workspace
            </button>
          )}
        </div>

        {scope === 'team' && (
          <p className="text-xs text-text-muted mt-2">
            This role will be the default for all workspaces in your team. Individual workspaces can add overrides.
          </p>
        )}

        {scope === 'workspace' && workspaces.length > 0 && (
          <div className="mt-3">
            <Select
              value={targetWorkspaceId}
              onChange={setTargetWorkspaceId}
              options={workspaces.map(w => ({ value: w.id, label: w.name }))}
              size="sm"
            />
            <p className="text-xs text-text-muted mt-1">
              This role will only be available in the selected workspace.
            </p>
          </div>
        )}
      </div>

      <div className="border border-border-default rounded-lg p-6">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Left: Identity */}
          <div className="flex-1 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                placeholder="Builder"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Slug</label>
              <input
                type="text"
                value={slug}
                onChange={(e) => { setSlugManual(true); setSlug(e.target.value); }}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
                placeholder="builder"
                pattern="^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
              />
              <p className="text-xs text-text-muted mt-1">Auto-generated from name.</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Goal</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                placeholder="Ship high-quality code"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Instructions</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
                placeholder="You are Builder, a senior software engineer..."
                required
              />
              <p className="text-xs text-text-muted mt-1">This becomes the agent&apos;s system prompt.</p>
            </div>
          </div>

          {/* Right: Config */}
          <div className="w-full md:w-[300px] space-y-5">
            <div>
              <label className="block text-sm font-medium mb-1.5">Model</label>
              <Select
                value={model}
                onChange={setModel}
                options={MODEL_OPTIONS}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Agent backend</label>
              <BackendSelect value={defaultBackend} onChange={setDefaultBackend} inheritLabel="Inherit" />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">
                Allowed Tools
                <span className="text-text-muted font-normal ml-1">
                  {allowedTools.length === 0 ? '(all)' : `(${allowedTools.length})`}
                </span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_TOOLS.map(tool => {
                  const active = allowedTools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                        active
                          ? 'bg-text-primary text-white border-text-primary'
                          : 'bg-surface-2 border-border-default text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-text-muted mt-1">Empty = all tools allowed.</p>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={background}
                  onChange={(e) => setBackground(e.target.checked)}
                  className="rounded border-border-default"
                />
                <span className="text-[13px] text-text-primary">Background execution</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-text-primary">Max turns</span>
                <input
                  type="number"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  className="w-20 px-2 py-1 border border-border-default rounded-md bg-surface-1 text-sm"
                  placeholder="--"
                  min="1"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Color</label>
              <div className="flex gap-2">
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full transition-all ${
                      color === c ? 'ring-2 ring-offset-2 ring-text-primary scale-110' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-6 pt-6 border-t border-border-default">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create Role'}
          </button>
          <Link
            href="/app/team"
            className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3 text-sm"
          >
            Cancel
          </Link>
          {error && <span className="text-status-error text-sm">{error}</span>}
        </div>
      </div>
    </form>
  );
}
