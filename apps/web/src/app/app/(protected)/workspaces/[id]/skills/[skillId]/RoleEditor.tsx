'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';

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

type Scope = 'team' | 'workspace';

/**
 * A team connector as surfaced by GET /api/connectors.
 *   - id, name, url, authMode, status, transport are projected by the list route.
 *   - workspaceScoped: false = team-wide reach (visible in every workspace); true =
 *     opt-in allowlist mounted only in enabledWorkspaceIds (unified-sharing Phase 3).
 *   - enabledWorkspaceIds: workspaces with an enabled mount row. For a workspace-scoped
 *     connector this is its allowlist; the editor uses it to render reach and to block
 *     mounting a connector scoped to a different workspace than this role's.
 *   - needsReview: true for migrated placeholders (discoveredMetadata.needsReview,
 *     spec §4) — the URL/auth still needs a human.
 */
interface Connector {
  id: string;
  name: string;
  url: string | null;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  transport?: 'http' | 'stdio';
  workspaceScoped?: boolean;
  enabledWorkspaceIds?: string[];
  needsReview?: boolean;
}

/**
 * Payload sent to POST /api/connectors when installing a registry entry.
 *
 * ASSUMED SHAPE (reconcile with the connectors API agent — spec §5/§6):
 *   - `reuseIfExists: true` → create-or-reuse by (teamId, name); no 409 on repeat.
 *   - http transport carries `url` (authMode discovered server-side via probe).
 *   - stdio transport carries `command`/`args`/`envMapping` and `authMode:'none'`;
 *     `url` is omitted (POST must not require url for stdio).
 */
interface ConnectorCreateInput {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  envMapping?: Record<string, string>;
  authMode?: 'none' | 'header' | 'oauth';
  reuseIfExists: true;
}

interface Skill {
  id: string;
  slug: string;
  teamId: string;
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
  // IDs of team connectors this role opts into (spec §2). Superseded fields
  // mcpServers/requiredEnvVars are no longer read or written by this editor.
  connectorRefs: string[] | null;
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

/** Small auth-mode + connection-status badge, matching Settings → Connectors. */
function ConnectorBadge({ authMode, status }: { authMode: Connector['authMode']; status: Connector['status'] }) {
  if (authMode === 'none') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-status-info/10 text-status-info border border-status-info/30">
        public
      </span>
    );
  }
  const label = authMode === 'oauth' ? 'oauth' : 'header';
  if (status === 'connected') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-status-success/10 text-status-success border border-status-success/30">
        {label} · connected
      </span>
    );
  }
  if (status === 'expired') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-status-warning/10 text-status-warning border border-status-warning/30">
        {label} · expired
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-surface-3 text-text-muted border border-border-default">
      {label} · connect
    </span>
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

/** Short display name from registry name like "io.github/user-repo" */
function shortName(registryName: string): string {
  const parts = registryName.split('/');
  return parts[parts.length - 1] || registryName;
}

/**
 * Convert a registry entry into a connector-create payload (spec §5).
 * Prefers a remote (http) transport; falls back to an npm package as stdio with
 * envMapping seeded from the entry's declared environmentVariables.
 */
function registryToConnectorInput(entry: RegistryServer['server']): ConnectorCreateInput {
  const name = shortName(entry.name);

  const remote = entry.remotes?.[0];
  if (remote) {
    // http: authMode discovered server-side by probing the URL.
    return { name, transport: 'http', url: remote.url, reuseIfExists: true };
  }

  const pkg = entry.packages?.find(p => p.registryType === 'npm');
  if (pkg) {
    const envMapping: Record<string, string> = {};
    for (const ev of pkg.environmentVariables || []) {
      // Seed env var name → secret label placeholder (human completes the label).
      envMapping[ev.name] = ev.name;
    }
    return {
      name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', pkg.identifier],
      envMapping,
      authMode: 'none',
      reuseIfExists: true,
    };
  }

  // No remote and no npm package — create a placeholder http connector the user
  // completes later.
  return { name, transport: 'http', reuseIfExists: true };
}

function McpRegistryBrowser({ onInstall, installedNames, installing }: {
  onInstall: (input: ConnectorCreateInput) => void;
  installedNames: string[];
  installing: string | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
            const isInstalling = installing === displayName;
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
                    disabled={isInstalled || isInstalling}
                    onClick={() => onInstall(registryToConnectorInput(s))}
                    className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                      isInstalled
                        ? 'bg-surface-3 text-text-muted cursor-default'
                        : 'bg-primary text-white hover:bg-primary-hover disabled:opacity-50'
                    }`}
                  >
                    {isInstalled ? 'Added' : isInstalling ? 'Adding…' : '+ Add'}
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
  const [defaultBackend, setDefaultBackend] = useState<BackendValue>(skill.defaultBackend ?? null);
  const [allowedTools, setAllowedTools] = useState<string[]>(skill.allowedTools);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>(skill.canDelegateTo);
  const [background, setBackground] = useState(skill.background);
  const [maxTurns, setMaxTurns] = useState<string>(skill.maxTurns?.toString() || '');
  const [color, setColor] = useState(skill.color);
  const [isRole, setIsRole] = useState(skill.isRole);
  const [repoUrl, setRepoUrl] = useState(skill.repoUrl || '');

  // Connectors (spec §2): role opts into team connectors by id.
  const [connectorRefs, setConnectorRefs] = useState<string[]>(skill.connectorRefs ?? []);
  const [teamConnectors, setTeamConnectors] = useState<Connector[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [showBrowse, setShowBrowse] = useState(false);

  // Scope (applies-to) state — workspace-scoped roles always start as 'workspace'
  const [scope, setScope] = useState<Scope>('workspace');

  // Load the team's connectors for the picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setConnectorsLoading(true);
      try {
        const res = await fetch(`/api/connectors?teamId=${encodeURIComponent(skill.teamId)}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setTeamConnectors(data.connectors || []);
        }
      } catch {
        // silent — picker just shows empty
      } finally {
        if (!cancelled) setConnectorsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [skill.teamId]);

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

  // Reach in the shared sharing vocabulary. Team-wide connectors read "This team";
  // workspace-scoped ones read "One workspace: <name>" from their allowlist.
  const wsNameById = new Map(userWorkspaces.map(w => [w.id, w.name]));
  const reachLabel = (c: Connector): string => {
    if (!c.workspaceScoped) return 'This team';
    const names = (c.enabledWorkspaceIds ?? []).map(id => wsNameById.get(id) ?? 'a workspace');
    if (names.length === 0) return 'One workspace';
    return `One workspace: ${names.join(', ')}`;
  };
  // A workspace-scoped connector is out of scope for THIS role unless its allowlist
  // includes this workspace. A workspace-scoped role must not mount such a connector.
  const isOutOfScope = (c: Connector): boolean =>
    !!c.workspaceScoped && !(c.enabledWorkspaceIds ?? []).includes(workspaceId);

  const toggleConnector = (id: string) => {
    const connector = teamConnectors.find(c => c.id === id);
    // Block mounting a connector scoped to a different workspace (validated again server-side).
    if (connector && isOutOfScope(connector) && !connectorRefs.includes(id)) return;
    setConnectorRefs(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  // Browse Registry → create (or reuse) a team connector, then opt the role in.
  async function installConnector(input: ConnectorCreateInput) {
    setInstalling(input.name);
    setError(null);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to add connector');
      }
      const data = await res.json();
      const created: Connector | undefined = data.connector;
      if (created?.id) {
        setTeamConnectors(prev =>
          prev.some(c => c.id === created.id) ? prev : [...prev, created]
        );
        setConnectorRefs(prev => (prev.includes(created.id) ? prev : [...prev, created.id]));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add connector');
    } finally {
      setInstalling(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
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
        connectorRefs,
        isRole,
        repoUrl: repoUrl || null,
      };

      let res: Response;
      if (scope === 'team') {
        // Promoting to team-level: use /api/roles/[id] with workspaceId: null
        res = await fetch(`/api/roles/${skill.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, workspaceId: null }),
        });
      } else {
        res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      // If promoted to team-level, redirect to team role settings
      if (scope === 'team') {
        router.push(`/app/team/${skill.slug}/settings`);
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

  // Names of connectors the role already references — drives the registry "Added" state.
  const installedConnectorNames = teamConnectors
    .filter(c => connectorRefs.includes(c.id))
    .map(c => c.name);

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
            <div className="flex items-center gap-2 flex-wrap text-[13px] text-text-muted mt-0.5">
              <span className="font-mono text-xs">{skill.slug}</span>
              <span>&middot;</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-3 text-text-muted">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9,22 9,12 15,12 15,22" />
                </svg>
                {workspaceName}
              </span>
              <span>&middot;</span>
              <span>Created {createdDate}</span>
            </div>
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

        {/* Applies to */}
        <div className="border border-border-default rounded-lg p-4 mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-text-secondary">Applies to</span>
          </div>
          <div className="flex rounded-md border border-border-default overflow-hidden w-fit">
            <button
              type="button"
              onClick={() => setScope('workspace')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                scope === 'workspace'
                  ? 'bg-surface-3 text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              One workspace
            </button>
            <button
              type="button"
              onClick={() => setScope('team')}
              className={`px-4 py-2 text-sm font-medium border-l border-border-default transition-colors ${
                scope === 'team'
                  ? 'bg-surface-3 text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              All workspaces in team
            </button>
          </div>

          {scope === 'workspace' && (
            <p className="text-xs text-text-muted mt-2">
              This role is scoped to <span className="font-medium text-text-primary">{workspaceName}</span>.
            </p>
          )}

          {scope === 'team' && (
            <p className="text-xs text-text-muted mt-2">
              Saving will promote this role to team-level, making it the default for all workspaces.
            </p>
          )}
        </div>

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

            {/* Agent backend */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">Agent backend</label>
              <BackendSelect value={defaultBackend} onChange={setDefaultBackend} inheritLabel="Inherit" />
              <p className="text-xs text-text-muted mt-1.5">
                Default backend for tasks routed to this role. Requires that backend&apos;s credentials in Settings.
              </p>
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

            {/* Connectors — picker over the team's connectors (spec §2/§5) */}
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
              <p className="text-xs text-text-muted mb-2">Team MCP servers this role mounts at runtime</p>

              {showBrowse && (
                <div className="mb-3">
                  <McpRegistryBrowser
                    installedNames={installedConnectorNames}
                    installing={installing}
                    onInstall={installConnector}
                  />
                </div>
              )}

              <div className="space-y-2">
                {connectorsLoading && (
                  <p className="text-[12px] text-text-muted">Loading connectors…</p>
                )}
                {!connectorsLoading && teamConnectors.length === 0 && (
                  <p className="text-[12px] text-text-muted">
                    No team connectors yet. Browse the registry above or add one in Settings → Connectors.
                  </p>
                )}
                {teamConnectors.map((connector) => {
                  const active = connectorRefs.includes(connector.id);
                  const outOfScope = isOutOfScope(connector);
                  return (
                    <div
                      key={connector.id}
                      className={`border rounded-md overflow-hidden transition-colors ${
                        active ? 'border-text-primary' : 'border-border-default'
                      } ${outOfScope && !active ? 'opacity-60' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleConnector(connector.id)}
                        disabled={outOfScope && !active}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
                      >
                        <span
                          className={`w-4 h-4 flex-shrink-0 border-2 flex items-center justify-center ${
                            active ? 'bg-text-primary border-text-primary' : 'border-border-strong'
                          }`}
                        >
                          {active && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-surface-1">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium text-text-primary truncate">{connector.name}</span>
                            {connector.transport === 'stdio' && (
                              <span className="text-[10px] text-text-muted font-mono">stdio</span>
                            )}
                          </div>
                          {/* Reach in the shared vocabulary — consistent with the connector card + credentials. */}
                          <span className="block text-[11px] text-text-muted truncate">{reachLabel(connector)}</span>
                          {connector.url && (
                            <span className="block text-[11px] text-text-muted font-mono truncate">{connector.url}</span>
                          )}
                        </div>
                        <div className="flex-shrink-0 flex items-center gap-1.5">
                          {connector.needsReview && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-status-warning/10 text-status-warning border border-status-warning/30">
                              needs review
                            </span>
                          )}
                          <ConnectorBadge authMode={connector.authMode} status={connector.status} />
                        </div>
                      </button>
                      {outOfScope && (
                        <div className="px-3 py-1.5 bg-surface-2 border-t border-border-default">
                          <p className="text-[11px] text-text-muted">
                            Scoped to another workspace — cannot be mounted by a role in <span className="font-medium text-text-primary">{workspaceName}</span>.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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
