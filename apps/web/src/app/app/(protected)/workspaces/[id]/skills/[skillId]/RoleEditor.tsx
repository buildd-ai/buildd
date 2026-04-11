'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';

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

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'http';
  url?: string;
}

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
  mcpServers: Record<string, McpServerConfig> | string[];
  requiredEnvVars: Record<string, string>;
  isRole: boolean;
  repoUrl: string | null;
  createdAt: string;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  skill: Skill;
  delegateOptions: { slug: string; name: string }[];
  workspaces: WorkspaceOption[];
}

/** Normalize legacy string[] to Record<string, McpServerConfig> */
function normalizeMcpServers(raw: Record<string, McpServerConfig> | string[] | null): Record<string, McpServerConfig> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const result: Record<string, McpServerConfig> = {};
    for (const name of raw) {
      if (typeof name === 'string') result[name] = {};
    }
    return result;
  }
  return raw as Record<string, McpServerConfig>;
}

function McpServerEditor({
  name,
  config,
  onUpdate,
  onRemove,
}: {
  name: string;
  config: McpServerConfig;
  onUpdate: (config: McpServerConfig) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isHttp = config.type === 'http' || !!config.url;
  const hasConfig = config.command || config.url || (config.args && config.args.length > 0) || (config.env && Object.keys(config.env).length > 0);

  return (
    <div className="border border-border-default rounded-md overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-surface-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted flex-shrink-0">
          <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
        </svg>
        <span className="text-[13px] font-medium text-text-primary flex-1">{name}</span>
        {hasConfig && (
          <span className="text-[11px] text-text-muted">{isHttp ? 'HTTP' : 'stdio'}</span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      {expanded && (
        <div className="px-3 py-3 space-y-3 bg-surface-1">
          {/* Transport type */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ ...config, type: 'stdio', url: undefined })}
              className={`px-2.5 py-1 rounded text-[12px] font-medium border transition-colors ${
                !isHttp ? 'bg-text-primary text-white border-text-primary' : 'bg-surface-2 border-border-default text-text-muted'
              }`}
            >
              stdio
            </button>
            <button
              type="button"
              onClick={() => onUpdate({ ...config, type: 'http', command: undefined, args: undefined })}
              className={`px-2.5 py-1 rounded text-[12px] font-medium border transition-colors ${
                isHttp ? 'bg-text-primary text-white border-text-primary' : 'bg-surface-2 border-border-default text-text-muted'
              }`}
            >
              HTTP
            </button>
          </div>

          {isHttp ? (
            <div>
              <label className="block text-[12px] text-text-muted mb-1">URL</label>
              <input
                type="text"
                value={config.url || ''}
                onChange={(e) => onUpdate({ ...config, url: e.target.value || undefined })}
                className="w-full px-2 py-1.5 border border-border-default rounded text-[12px] font-mono bg-surface-1 text-text-primary"
                placeholder="http://localhost:3100/mcp"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[12px] text-text-muted mb-1">Command</label>
                <input
                  type="text"
                  value={config.command || ''}
                  onChange={(e) => onUpdate({ ...config, command: e.target.value || undefined })}
                  className="w-full px-2 py-1.5 border border-border-default rounded text-[12px] font-mono bg-surface-1 text-text-primary"
                  placeholder="npx, uvx, docker..."
                />
              </div>
              <div>
                <label className="block text-[12px] text-text-muted mb-1">Args</label>
                <input
                  type="text"
                  value={(config.args || []).join(' ')}
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    onUpdate({ ...config, args: val ? val.split(/\s+/) : undefined });
                  }}
                  className="w-full px-2 py-1.5 border border-border-default rounded text-[12px] font-mono bg-surface-1 text-text-primary"
                  placeholder="-y @modelcontextprotocol/server-github"
                />
                <p className="text-[11px] text-text-muted mt-0.5">Space-separated arguments</p>
              </div>
            </>
          )}

          {/* Env vars per server */}
          <div>
            <label className="block text-[12px] text-text-muted mb-1">Environment</label>
            <div className="space-y-1">
              {Object.entries(config.env || {}).map(([key, value]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <code className="px-1.5 py-0.5 bg-surface-3 rounded text-[11px] font-mono text-text-primary">{key}</code>
                  <span className="text-[11px] text-text-muted">=</span>
                  <span className="text-[11px] text-text-muted flex-1 truncate">{value}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...config.env };
                      delete next[key];
                      onUpdate({ ...config, env: Object.keys(next).length > 0 ? next : undefined });
                    }}
                    className="text-text-muted hover:text-status-error text-[11px]"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <form
              className="flex items-center gap-1.5 mt-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.target as HTMLFormElement;
                const keyInput = form.elements.namedItem('envKey') as HTMLInputElement;
                const valInput = form.elements.namedItem('envVal') as HTMLInputElement;
                const k = keyInput.value.trim();
                const v = valInput.value.trim();
                if (k && v) {
                  onUpdate({ ...config, env: { ...(config.env || {}), [k]: v } });
                  keyInput.value = '';
                  valInput.value = '';
                }
              }}
            >
              <input name="envKey" type="text" placeholder="KEY" className="w-24 px-1.5 py-1 border border-border-default rounded text-[11px] font-mono bg-surface-1 text-text-primary" />
              <input name="envVal" type="text" placeholder="value" className="flex-1 px-1.5 py-1 border border-border-default rounded text-[11px] bg-surface-1 text-text-primary" />
              <button type="submit" className="px-2 py-1 rounded text-[11px] border border-border-default text-text-muted hover:text-text-secondary">+</button>
            </form>
          </div>

          <button
            type="button"
            onClick={onRemove}
            className="text-[12px] text-status-error hover:underline"
          >
            Remove server
          </button>
        </div>
      )}
    </div>
  );
}

interface RegistryServer {
  server: {
    name: string;
    description: string;
    title?: string;
    version: string;
    repository?: { url: string; source: string };
    remotes?: { type: string; url: string; headers?: { name: string; description: string; isRequired?: boolean; isSecret?: boolean }[] }[];
    packages?: { registryType: string; identifier: string; transport: string[]; environmentVariables?: { name: string; description: string; isRequired?: boolean; isSecret?: boolean }[] }[];
  };
}

/** Convert a registry server entry into an MCP config */
function registryToConfig(entry: RegistryServer['server']): McpServerConfig {
  // Prefer remote (HTTP) if available
  const remote = entry.remotes?.[0];
  if (remote) {
    const config: McpServerConfig = { type: 'http', url: remote.url };
    // Add required header env stubs
    const envHeaders = remote.headers?.filter(h => h.isSecret || h.isRequired);
    if (envHeaders?.length) {
      config.env = {};
      for (const h of envHeaders) {
        config.env[h.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')] = `\${${h.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`;
      }
    }
    return config;
  }
  // Fallback: try npm package
  const pkg = entry.packages?.find(p => p.registryType === 'npm');
  if (pkg) {
    const config: McpServerConfig = {
      command: 'npx',
      args: ['-y', pkg.identifier],
    };
    if (pkg.environmentVariables?.length) {
      config.env = {};
      for (const ev of pkg.environmentVariables) {
        config.env[ev.name] = `\${${ev.name}}`;
      }
    }
    return config;
  }
  return {};
}

/** Short display name from registry name like "io.github/user-repo" */
function shortName(registryName: string): string {
  const parts = registryName.split('/');
  return parts[parts.length - 1] || registryName;
}

function McpRegistryBrowser({ onInstall, installedNames }: {
  onInstall: (name: string, config: McpServerConfig) => void;
  installedNames: string[];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/mcp/registry?search=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.servers || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  function handleInput(val: string) {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 300);
  }

  return (
    <div className="border border-border-default rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-surface-2">
        <input
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Search MCP Registry..."
          className="w-full px-2.5 py-1.5 border border-border-default rounded-md text-[12px] bg-surface-1 text-text-primary"
        />
      </div>
      {loading && (
        <div className="px-3 py-3 text-[12px] text-text-muted">Searching...</div>
      )}
      {!loading && searched && results.length === 0 && (
        <div className="px-3 py-3 text-[12px] text-text-muted">No servers found</div>
      )}
      {results.length > 0 && (
        <div className="max-h-[280px] overflow-y-auto divide-y divide-border-default">
          {results.map((entry) => {
            const s = entry.server;
            const displayName = shortName(s.name);
            const isInstalled = installedNames.includes(displayName);
            const hasRemote = !!s.remotes?.length;
            const hasPkg = !!s.packages?.find(p => p.registryType === 'npm');

            return (
              <div key={s.name + s.version} className="px-3 py-2.5 hover:bg-surface-2 transition-colors">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-text-primary truncate">{s.title || displayName}</span>
                      <span className="text-[11px] text-text-muted">v{s.version}</span>
                    </div>
                    <p className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{s.description}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {hasRemote && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-text-muted">HTTP</span>}
                      {hasPkg && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-text-muted">npm</span>}
                      {s.repository && (
                        <a
                          href={s.repository.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-text-muted hover:text-text-secondary"
                          onClick={(e) => e.stopPropagation()}
                        >
                          repo
                        </a>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isInstalled}
                    onClick={() => {
                      const config = registryToConfig(s);
                      onInstall(displayName, config);
                    }}
                    className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                      isInstalled
                        ? 'bg-surface-3 text-text-muted cursor-default'
                        : 'bg-primary text-white hover:bg-primary-hover'
                    }`}
                  >
                    {isInstalled ? 'Added' : '+ Add'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!searched && !loading && (
        <div className="px-3 py-3 text-[11px] text-text-muted">
          Search the official MCP Registry for servers like &quot;github&quot;, &quot;slack&quot;, &quot;postgres&quot;...
        </div>
      )}
    </div>
  );
}

export function RoleEditor({ workspaceId, workspaceName, skill, delegateOptions, workspaces: userWorkspaces }: Props) {
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
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>(
    normalizeMcpServers(skill.mcpServers)
  );
  const [newServerName, setNewServerName] = useState('');
  const [showBrowse, setShowBrowse] = useState(false);
  const [envVars, setEnvVars] = useState<Record<string, string>>(skill.requiredEnvVars || {});
  const [isRole, setIsRole] = useState(skill.isRole);
  const [repoUrl, setRepoUrl] = useState(skill.repoUrl || '');
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

  function updateServer(name: string, config: McpServerConfig) {
    setMcpServers(prev => ({ ...prev, [name]: config }));
  }

  function removeServer(name: string) {
    setMcpServers(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function addServer(serverName: string) {
    const trimmed = serverName.trim();
    if (trimmed && !mcpServers[trimmed]) {
      setMcpServers(prev => ({ ...prev, [trimmed]: {} }));
    }
  }

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
          isRole,
          repoUrl: repoUrl || null,
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
            className="px-5 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
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
              <Select
                value={model}
                onChange={setModel}
                options={MODEL_OPTIONS}
              />
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

            {/* Connectors (MCP Servers) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-text-primary">Connectors</label>
                <button
                  type="button"
                  onClick={() => setShowBrowse(!showBrowse)}
                  className="text-[12px] text-primary hover:text-primary-hover font-medium"
                >
                  {showBrowse ? 'Hide Registry' : 'Browse Registry'}
                </button>
              </div>
              <p className="text-xs text-text-muted mb-2">MCP servers available to this role at runtime</p>

              {showBrowse && (
                <div className="mb-3">
                  <McpRegistryBrowser
                    installedNames={Object.keys(mcpServers)}
                    onInstall={(installName, config) => {
                      setMcpServers(prev => ({ ...prev, [installName]: config }));
                    }}
                  />
                </div>
              )}

              <div className="space-y-2">
                {Object.entries(mcpServers).map(([serverName, config]) => (
                  <McpServerEditor
                    key={serverName}
                    name={serverName}
                    config={config}
                    onUpdate={(c) => updateServer(serverName, c)}
                    onRemove={() => removeServer(serverName)}
                  />
                ))}
              </div>
              <form
                className="flex items-center gap-2 mt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newServerName.trim()) {
                    addServer(newServerName);
                    setNewServerName('');
                  }
                }}
              >
                <input
                  type="text"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                  placeholder="Server name"
                  className="flex-1 px-2.5 py-1.5 border border-border-default rounded-md text-[12px] bg-surface-1 text-text-primary"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-md text-[12px] border border-border-default text-text-muted hover:text-text-secondary"
                >
                  + Add
                </button>
              </form>
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

            {/* Allowed Tools (collapsed) */}
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
                <p className="text-xs text-text-muted mt-1">Empty = all tools allowed.</p>
              </div>
            </details>

            {/* Settings */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Settings</label>
              <div className="space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isRole}
                    onChange={(e) => setIsRole(e.target.checked)}
                    className="rounded border-border-default"
                  />
                  <span className="text-[13px] text-text-primary">Show on Team page</span>
                </label>

                {isRole && (
                  <div>
                    <span className="text-[13px] text-text-primary block mb-1">Workspace</span>
                    <Select
                      value={repoUrl || ''}
                      onChange={setRepoUrl}
                      options={[
                        { value: '', label: 'No linked workspace' },
                        ...userWorkspaces.map(ws => ({ value: ws.id, label: ws.name })),
                      ]}
                      size="sm"
                    />
                    <p className="text-[11px] text-text-muted mt-1">Link to a workspace for builder roles</p>
                  </div>
                )}

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
