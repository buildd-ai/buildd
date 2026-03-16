'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

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
  '#C45A3B', '#5B7BB3', '#6B8E5E', '#D97706',
  '#9B59B6', '#2C8C99', '#C4783B', '#8A8478',
];

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  color: string;
  mcpServers: string[];
  requiredEnvVars: Record<string, string>;
  createdAt: string;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  skill: Skill;
  delegateOptions: { slug: string; name: string }[];
}

export function RoleEditor({ workspaceId, workspaceName, skill, delegateOptions }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description || '');
  const [content, setContent] = useState(skill.content);
  const [model, setModel] = useState(skill.model);
  const [allowedTools, setAllowedTools] = useState<string[]>(skill.allowedTools);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>(skill.canDelegateTo);
  const [background, setBackground] = useState(skill.background);
  const [maxTurns, setMaxTurns] = useState<string>(skill.maxTurns?.toString() || '');
  const [color, setColor] = useState(skill.color);
  const [mcpServers, setMcpServers] = useState<string[]>(skill.mcpServers || []);
  const [newMcpServer, setNewMcpServer] = useState('');
  const [envVars, setEnvVars] = useState<Record<string, string>>(skill.requiredEnvVars || {});
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');

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

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description || null,
          content,
          model,
          allowedTools,
          canDelegateTo,
          background,
          maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
          color,
          mcpServers,
          requiredEnvVars: envVars,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete role "${skill.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      router.push('/app/team');
      router.refresh();
    } catch {
      setError('Failed to delete role');
      setDeleting(false);
    }
  }

  const initial = name[0]?.toUpperCase() || '?';
  const createdDate = new Date(skill.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[13px] mb-5">
          <Link href="/app/team" className="text-text-muted hover:text-text-secondary">Team</Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-primary font-medium">{name}</span>
        </div>

        {/* Header: Avatar + Name + Save */}
        <div className="flex items-center gap-4 mb-8">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: color }}
          >
            <span className="text-white text-2xl font-bold">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-text-primary">{name}</h1>
            <p className="text-[13px] text-text-muted">
              {skill.slug} &middot; Created {createdDate}
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-text-primary text-white rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-2 rounded-md bg-status-error/10 text-status-error text-sm">
            {error}
          </div>
        )}

        {/* Two-column form */}
        <div className="flex flex-col md:flex-row gap-8">
          {/* Left: Identity */}
          <div className="flex-1 space-y-5">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Role Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary"
                placeholder="Builder"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Goal</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary"
                placeholder="Describe this role's core purpose (one sentence)"
              />
              <p className="text-xs text-text-muted mt-1">Shown on the Team page and in task routing.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Instructions</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={14}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm text-text-primary"
                placeholder="You are Builder, a senior software engineer..."
              />
              <p className="text-xs text-text-muted mt-1">Full SKILL.md content. This becomes the agent&apos;s system prompt.</p>
            </div>
          </div>

          {/* Right: Config */}
          <div className="w-full md:w-[340px] space-y-6">
            {/* Model */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary"
              >
                {MODEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Can Delegate To */}
            {delegateOptions.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-2">Can Delegate To</label>
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
              <label className="block text-sm font-medium text-text-primary mb-2">
                Allowed Tools
                <span className="text-text-muted font-normal ml-1">
                  {allowedTools.length === 0 ? '(all)' : `(${allowedTools.length})`}
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_TOOLS.map(tool => {
                  const active = allowedTools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={`px-2.5 py-1 rounded-md text-[12px] font-mono border transition-colors ${
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

            {/* Connectors (MCP Servers) */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Connectors</label>
              <p className="text-xs text-text-muted mb-2">MCP servers this role can use</p>
              <div className="flex flex-wrap gap-2">
                {mcpServers.map(server => (
                  <span
                    key={server}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium bg-text-primary text-white"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                      <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
                    </svg>
                    {server}
                    <button
                      type="button"
                      onClick={() => setMcpServers(prev => prev.filter(s => s !== server))}
                      className="ml-0.5 hover:opacity-70"
                    >
                      &times;
                    </button>
                  </span>
                ))}
                <form
                  className="inline-flex"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newMcpServer.trim() && !mcpServers.includes(newMcpServer.trim())) {
                      setMcpServers(prev => [...prev, newMcpServer.trim()]);
                      setNewMcpServer('');
                    }
                  }}
                >
                  <input
                    type="text"
                    value={newMcpServer}
                    onChange={(e) => setNewMcpServer(e.target.value)}
                    placeholder="+ Add"
                    className="w-20 px-2.5 py-1 rounded-full text-[12px] border border-border-default bg-transparent text-text-muted placeholder:text-text-muted focus:w-32 transition-all"
                  />
                </form>
              </div>
            </div>

            {/* Environment (Required Env Vars) */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Environment</label>
              <p className="text-xs text-text-muted mb-2">Secrets injected as env vars at runtime</p>
              <div className="space-y-1.5">
                {Object.entries(envVars).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <code className="px-2 py-1 bg-surface-3 rounded text-[12px] font-mono text-text-primary">{key}</code>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted flex-shrink-0">
                      <path d="M5 12h14m-7-7 7 7-7 7" />
                    </svg>
                    <span className="text-[12px] text-text-muted">{value}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...envVars };
                        delete next[key];
                        setEnvVars(next);
                      }}
                      className="ml-auto text-text-muted hover:text-status-error text-[12px]"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
              <form
                className="flex items-center gap-2 mt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newEnvKey.trim() && newEnvValue.trim()) {
                    setEnvVars(prev => ({ ...prev, [newEnvKey.trim()]: newEnvValue.trim() }));
                    setNewEnvKey('');
                    setNewEnvValue('');
                  }
                }}
              >
                <input
                  type="text"
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value)}
                  placeholder="KEY"
                  className="w-28 px-2 py-1 border border-border-default rounded text-[12px] font-mono bg-surface-1 text-text-primary"
                />
                <input
                  type="text"
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  placeholder="secret-name"
                  className="flex-1 px-2 py-1 border border-border-default rounded text-[12px] bg-surface-1 text-text-primary"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1 rounded-full text-[12px] border border-border-default text-text-muted hover:text-text-secondary"
                >
                  + Add
                </button>
              </form>
            </div>

            {/* Settings */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Settings</label>
              <div className="space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={background}
                    onChange={(e) => setBackground(e.target.checked)}
                    className="rounded border-border-default"
                  />
                  <span className="text-[13px] text-text-primary">Allow background execution</span>
                </label>

                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-text-primary">Max turns</span>
                  <input
                    type="number"
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    className="w-20 px-2 py-1 border border-border-default rounded-md bg-surface-1 text-sm text-text-primary"
                    placeholder="--"
                    min="1"
                  />
                </div>
              </div>
            </div>

            {/* Color */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Avatar Color</label>
              <div className="flex gap-2">
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`w-7 h-7 rounded-full transition-all ${
                      color === c ? 'ring-2 ring-offset-2 ring-text-primary scale-110' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            {/* Delete */}
            <div className="pt-4 border-t border-border-default">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-[13px] text-status-error hover:underline disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete this role'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
