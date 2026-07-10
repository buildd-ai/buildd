'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';

type Scope = 'team' | 'workspace';

const MODEL_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'opus', label: 'Claude Opus 4' },
  { value: 'sonnet', label: 'Claude Sonnet 4' },
  { value: 'haiku', label: 'Claude Haiku 4.5' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-fable-5', label: 'Claude Fable 5' },
] as const;

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit',
];

const COLOR_PALETTE = [
  '#D4724A', '#5B7BB3', '#6B8E5E', '#C4963B',
  '#9B59B6', '#2C8C99', '#D4A24A', '#8A8478',
];

interface Role {
  id: string;
  teamId: string;
  workspaceId: string | null;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  model: string;
  defaultBackend: 'claude' | 'codex' | null;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  color: string;
  mcpServers: Record<string, unknown> | string[];
  requiredEnvVars: Record<string, string>;
  isRole: boolean;
  repoUrl: string | null;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

interface Props {
  role: Role;
  overrides: Role[];
  workspaces: WorkspaceOption[];
  delegateOptions: { slug: string; name: string }[];
}

/** Fields that can be individually overridden per workspace */
type OverridableField = 'allowedTools' | 'content' | 'mcpServers';
const OVERRIDABLE_FIELDS: { key: OverridableField; label: string }[] = [
  { key: 'allowedTools', label: 'Allowed Tools' },
  { key: 'content', label: 'Instructions' },
  { key: 'mcpServers', label: 'Connectors (MCP)' },
];

/** Shows an inherited field value from the team default */
function InheritedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-3 text-text-muted">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7" />
      </svg>
      Inherited
    </span>
  );
}

/** Shows an overridden field badge */
function OverrideBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent-text/10 text-accent-text">
      Override
    </span>
  );
}

/** Workspace override editor: shows which fields are overridden vs inherited */
function WorkspaceOverrideEditor({
  override,
  teamDefault,
  workspaceName,
  onUpdate,
  onDelete,
}: {
  override: Role;
  teamDefault: Role;
  workspaceName: string;
  onUpdate: (updates: Partial<Record<OverridableField, unknown>>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect which fields differ from team default
  const overriddenFields = new Set<OverridableField>();
  if (JSON.stringify(override.allowedTools) !== JSON.stringify(teamDefault.allowedTools)) {
    overriddenFields.add('allowedTools');
  }
  if (override.content !== teamDefault.content) {
    overriddenFields.add('content');
  }
  if (JSON.stringify(override.mcpServers) !== JSON.stringify(teamDefault.mcpServers)) {
    overriddenFields.add('mcpServers');
  }

  // Editable state for overridable fields
  const [allowedTools, setAllowedTools] = useState<string[]>(override.allowedTools);
  const [content, setContent] = useState(override.content);
  const [overrideField, setOverrideField] = useState<Set<OverridableField>>(new Set(overriddenFields));

  function toggleToolOverride(tool: string) {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
    setOverrideField(prev => { const s = new Set(prev); s.add('allowedTools'); return s; });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const updates: Partial<Record<OverridableField, unknown>> = {};
    if (overrideField.has('allowedTools')) updates.allowedTools = allowedTools;
    if (overrideField.has('content')) updates.content = content;
    try {
      await onUpdate(updates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function resetField(field: OverridableField) {
    setOverrideField(prev => { const s = new Set(prev); s.delete(field); return s; });
    if (field === 'allowedTools') setAllowedTools(teamDefault.allowedTools);
    if (field === 'content') setContent(teamDefault.content);
  }

  return (
    <div className="border border-border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-surface-3 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-text-muted flex-shrink-0">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9,22 9,12 15,12 15,22" />
          </svg>
          <span className="text-[13px] font-medium text-text-primary">{workspaceName}</span>
          {overriddenFields.size > 0 && (
            <span className="text-[10px] text-text-muted">
              {overriddenFields.size} field{overriddenFields.size !== 1 ? 's' : ''} overridden
            </span>
          )}
          {overriddenFields.size === 0 && (
            <span className="text-[10px] text-text-muted">All inherited</span>
          )}
        </div>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="p-4 space-y-5">
          {/* Allowed Tools */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-sm font-medium text-text-primary">Allowed Tools</label>
              {overrideField.has('allowedTools') ? (
                <>
                  <OverrideBadge />
                  <button
                    type="button"
                    onClick={() => resetField('allowedTools')}
                    className="text-[10px] text-text-muted hover:text-status-error ml-auto"
                  >
                    Reset to inherited
                  </button>
                </>
              ) : (
                <>
                  <InheritedBadge />
                  <button
                    type="button"
                    onClick={() => { setOverrideField(prev => { const s = new Set(prev); s.add('allowedTools'); return s; }); }}
                    className="text-[10px] text-accent-text hover:underline ml-auto"
                  >
                    Override
                  </button>
                </>
              )}
            </div>
            {overrideField.has('allowedTools') ? (
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_TOOLS.map(tool => {
                  const active = allowedTools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleToolOverride(tool)}
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
            ) : (
              <div className="flex flex-wrap gap-1.5 opacity-50 pointer-events-none">
                {teamDefault.allowedTools.length === 0 ? (
                  <span className="text-xs text-text-muted">All tools allowed (inherited)</span>
                ) : (
                  teamDefault.allowedTools.map(tool => (
                    <span key={tool} className="px-2 py-0.5 rounded text-[11px] font-mono border bg-text-primary text-white border-text-primary">
                      {tool}
                    </span>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Instructions */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-sm font-medium text-text-primary">Instructions</label>
              {overrideField.has('content') ? (
                <>
                  <OverrideBadge />
                  <button
                    type="button"
                    onClick={() => resetField('content')}
                    className="text-[10px] text-text-muted hover:text-status-error ml-auto"
                  >
                    Reset to inherited
                  </button>
                </>
              ) : (
                <>
                  <InheritedBadge />
                  <button
                    type="button"
                    onClick={() => setOverrideField(prev => { const s = new Set(prev); s.add('content'); return s; })}
                    className="text-[10px] text-accent-text hover:underline ml-auto"
                  >
                    Override
                  </button>
                </>
              )}
            </div>
            {overrideField.has('content') ? (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm text-text-primary"
                placeholder="Custom instructions for this workspace..."
              />
            ) : (
              <div className="px-3 py-2 border border-border-default rounded-md bg-surface-2 opacity-60">
                <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap line-clamp-3">
                  {teamDefault.content.slice(0, 200)}{teamDefault.content.length > 200 ? '…' : ''}
                </pre>
              </div>
            )}
          </div>

          {error && (
            <div className="px-3 py-2 rounded-md bg-status-error/10 text-status-error text-sm">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2 border-t border-border-default">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save override'}
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="text-[12px] text-status-error hover:underline"
            >
              Remove override
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TeamRoleEditor({ role, overrides, workspaces: userWorkspaces, delegateOptions }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideList, setOverrideList] = useState<Role[]>(overrides);

  // Core role state
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description || '');
  const [content, setContent] = useState(role.content);
  const [model, setModel] = useState(role.model);
  const [defaultBackend, setDefaultBackend] = useState<BackendValue>(role.defaultBackend ?? null);
  const [allowedTools, setAllowedTools] = useState<string[]>(role.allowedTools);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>(role.canDelegateTo);
  const [background, setBackground] = useState(role.background);
  const [maxTurns, setMaxTurns] = useState<string>(role.maxTurns?.toString() || '');
  const [color, setColor] = useState(role.color);

  // Scope (applies-to) state — team-level roles always start as 'team'
  const [scope, setScope] = useState<Scope>('team');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>(userWorkspaces[0]?.id || '');

  // Add override state
  const [showAddOverride, setShowAddOverride] = useState(false);
  const [addOverrideWsId, setAddOverrideWsId] = useState(userWorkspaces[0]?.id || '');
  const [addingOverride, setAddingOverride] = useState(false);

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
      const body: Record<string, unknown> = {
        name,
        description: description || null,
        content,
        model,
        defaultBackend,
        allowedTools,
        canDelegateTo,
        background,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
        color,
      };

      // Include scope change if applicable
      if (scope === 'workspace' && targetWorkspaceId) {
        body.workspaceId = targetWorkspaceId;
      }

      const res = await fetch(`/api/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      // If scope changed to workspace, redirect to workspace skills editor
      if (scope === 'workspace' && targetWorkspaceId) {
        router.push(`/app/workspaces/${targetWorkspaceId}/skills/${role.id}`);
        return;
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete role "${role.name}"? This will also remove all workspace overrides and cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/roles/${role.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      router.push('/app/team');
      router.refresh();
    } catch {
      setError('Failed to delete role');
      setDeleting(false);
    }
  }

  async function handleUpdateOverride(overrideId: string, wsId: string, updates: Partial<Record<string, unknown>>) {
    const res = await fetch(`/api/roles/${role.id}/overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId, ...updates }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update override');
    }
    const data = await res.json();
    setOverrideList(prev => prev.map(o => o.id === overrideId ? data.skill : o));
  }

  async function handleDeleteOverride(overrideId: string) {
    if (!confirm('Remove this workspace override? The workspace will use the team default instead.')) return;
    const res = await fetch(`/api/roles/${overrideId}`, { method: 'DELETE' });
    if (res.ok) {
      setOverrideList(prev => prev.filter(o => o.id !== overrideId));
    }
  }

  async function handleAddOverride() {
    if (!addOverrideWsId) return;
    setAddingOverride(true);
    try {
      const res = await fetch(`/api/roles/${role.id}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: addOverrideWsId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create override');
      }
      const data = await res.json();
      setOverrideList(prev => [...prev, data.skill]);
      setShowAddOverride(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create override');
    } finally {
      setAddingOverride(false);
    }
  }

  const initial = name[0]?.toUpperCase() || '?';
  const wsMap = new Map(userWorkspaces.map(w => [w.id, w.name]));
  const overrideWsIds = new Set(overrideList.map(o => o.workspaceId).filter(Boolean));
  const availableForOverride = userWorkspaces.filter(w => !overrideWsIds.has(w.id));

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[13px] mb-5">
          <Link href="/app/team" className="text-text-muted hover:text-text-secondary">Team</Link>
          <span className="text-text-muted">/</span>
          <Link href={`/app/team/${role.slug}`} className="text-text-muted hover:text-text-secondary">{name}</Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-primary font-medium">Settings</span>
        </div>

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: color }}
          >
            <span className="text-white text-2xl font-bold">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-text-primary">{name}</h1>
            <div className="flex items-center gap-2 text-[13px] text-text-muted mt-0.5">
              <span className="font-mono text-xs">{role.slug}</span>
              <span>&middot;</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent-text/10 text-accent-text">
                All workspaces
              </span>
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>

        {error && (
          <div className="mb-6 px-4 py-2 rounded-md bg-status-error/10 text-status-error text-sm">
            {error}
          </div>
        )}

        {/* Applies to */}
        <div className="border border-border-default rounded-lg p-4 mb-8">
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
            {userWorkspaces.length > 0 && (
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
              This role is the default for all workspaces in your team. Individual workspaces can add overrides.
            </p>
          )}

          {scope === 'workspace' && userWorkspaces.length > 0 && (
            <div className="mt-3">
              <Select
                value={targetWorkspaceId}
                onChange={setTargetWorkspaceId}
                options={userWorkspaces.map(w => ({ value: w.id, label: w.name }))}
                size="sm"
              />
              <p className="text-xs text-text-muted mt-1">
                Saving will move this role to the selected workspace.
                {overrideList.length > 0 && (
                  <span className="text-status-warning ml-1">
                    {overrideList.length} workspace override{overrideList.length !== 1 ? 's' : ''} will become standalone roles.
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        {/* Two-column form */}
        <div className="flex flex-col md:flex-row gap-8 mb-10">
          {/* Left: Identity + Instructions */}
          <div className="flex-1 space-y-5">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Role Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Goal</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary"
                placeholder="Describe this role's core purpose"
              />
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
              <p className="text-xs text-text-muted mt-1">Full system prompt for this role. Individual workspaces can override this.</p>
            </div>
          </div>

          {/* Right: Config */}
          <div className="w-full md:w-[340px] space-y-6">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Model</label>
              <Select value={model} onChange={setModel} options={MODEL_OPTIONS} />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Agent backend</label>
              <BackendSelect value={defaultBackend} onChange={setDefaultBackend} inheritLabel="Inherit" />
            </div>

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
                        className={`px-3 py-1 text-[12px] font-medium border-2 transition-colors ${
                          active
                            ? 'bg-text-primary border-text-primary text-surface-1'
                            : 'bg-transparent border-border-strong text-text-secondary hover:text-text-primary'
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
            <details className="group">
              <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-text-primary">
                Allowed Tools
                <span className="text-text-muted font-normal text-[12px]">
                  {allowedTools.length === 0 ? 'All allowed' : `${allowedTools.length} restricted`}
                </span>
              </summary>
              <div className="mt-3">
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
                <p className="text-xs text-text-muted mt-1">Individual workspaces can override tool access.</p>
              </div>
            </details>

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
                {deleting ? 'Deleting…' : 'Delete this role'}
              </button>
            </div>
          </div>
        </div>

        {/* Workspace Overrides Section */}
        <div className="border-t border-border-default pt-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-[15px] font-semibold text-text-primary">Workspace Overrides</h2>
              <p className="text-[12px] text-text-muted mt-0.5">
                Individual workspaces can override specific fields. Non-overridden fields inherit the team default above.
              </p>
            </div>
            {availableForOverride.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAddOverride(!showAddOverride)}
                className="px-3 py-1.5 border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
              >
                + Add override
              </button>
            )}
          </div>

          {/* Add override form */}
          {showAddOverride && availableForOverride.length > 0 && (
            <div className="mb-4 p-4 border border-border-default rounded-lg bg-surface-2">
              <p className="text-[13px] text-text-primary mb-3">Create an override for a specific workspace</p>
              <div className="flex items-center gap-3">
                <Select
                  value={addOverrideWsId}
                  onChange={setAddOverrideWsId}
                  options={availableForOverride.map(w => ({ value: w.id, label: w.name }))}
                  size="sm"
                />
                <button
                  type="button"
                  onClick={handleAddOverride}
                  disabled={addingOverride || !addOverrideWsId}
                  className="px-3 py-1.5 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50"
                >
                  {addingOverride ? 'Creating…' : 'Create override'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddOverride(false)}
                  className="text-sm text-text-muted hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
              <p className="text-[11px] text-text-muted mt-2">
                The override starts as a copy of the team default. You can then customize specific fields for this workspace.
              </p>
            </div>
          )}

          {overrideList.length === 0 ? (
            <p className="text-[13px] text-text-muted">
              No workspace overrides. All workspaces use the team default.
            </p>
          ) : (
            <div className="space-y-3">
              {overrideList.map(override => {
                const wsId = override.workspaceId!;
                const wsName = wsMap.get(wsId) || wsId;
                return (
                  <WorkspaceOverrideEditor
                    key={override.id}
                    override={override}
                    teamDefault={role}
                    workspaceName={wsName}
                    onUpdate={(updates) => handleUpdateOverride(override.id, wsId, updates)}
                    onDelete={() => handleDeleteOverride(override.id)}
                  />
                );
              })}
            </div>
          )}

          {/* Resolution summary */}
          {userWorkspaces.length > 0 && (
            <div className="mt-6 p-4 border border-border-default rounded-lg bg-surface-2">
              <h3 className="text-[12px] font-semibold text-text-muted uppercase tracking-wider mb-3">
                Effective role per workspace
              </h3>
              <div className="space-y-1.5">
                {userWorkspaces.map(ws => {
                  const override = overrideList.find(o => o.workspaceId === ws.id);
                  return (
                    <div key={ws.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-text-primary">{ws.name}</span>
                      {override ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent-text/10 text-accent-text text-[10px] font-medium">
                          Workspace override
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-3 text-text-muted text-[10px]">
                          Team default
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
