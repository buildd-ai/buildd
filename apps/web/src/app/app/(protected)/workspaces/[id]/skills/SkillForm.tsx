'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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

interface Props {
  workspaceId: string;
  delegateOptions: { slug: string; name: string }[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function SkillForm({ workspaceId, delegateOptions }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('inherit');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>([]);
  const [background, setBackground] = useState(false);
  const [maxTurns, setMaxTurns] = useState('');
  const [color, setColor] = useState(COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugManual) {
      setSlug(slugify(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlugManual(true);
    setSlug(value);
  }

  const toggleTool = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const toggleDelegate = (slug: string) => {
    setCanDelegateTo(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          slug: slug || undefined,
          description: description || undefined,
          content,
          source: 'manual',
          model,
          allowedTools,
          canDelegateTo,
          background,
          maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
          color,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create role');
      }

      router.push(`/app/workspaces/${workspaceId}/skills`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border-default rounded-lg p-6">
      <h3 className="font-semibold text-lg mb-6">New Role</h3>

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
              onChange={(e) => handleSlugChange(e.target.value)}
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
          {/* Model */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
            >
              {MODEL_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Can Delegate To */}
          {delegateOptions.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-1.5">Can Delegate To</label>
              <div className="flex flex-wrap gap-2">
                {delegateOptions.map(opt => {
                  const active = canDelegateTo.includes(opt.slug);
                  return (
                    <button
                      key={opt.slug}
                      type="button"
                      onClick={() => toggleDelegate(opt.slug)}
                      className={`px-3 py-1 rounded-full text-[12px] font-medium border transition-colors ${
                        active
                          ? 'bg-status-success/10 border-status-success text-status-success'
                          : 'bg-surface-2 border-border-default text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {opt.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Allowed Tools */}
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

          {/* Settings */}
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

          {/* Color */}
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

        <a
          href={`/app/workspaces/${workspaceId}/skills`}
          className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
        >
          Cancel
        </a>

        {error && (
          <span className="text-status-error text-sm">{error}</span>
        )}
      </div>
    </form>
  );
}
