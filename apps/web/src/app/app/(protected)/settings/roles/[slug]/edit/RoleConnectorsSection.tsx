'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Section from '@/components/ui/Section';
import { TonePill } from '@/components/ui/StatePill';
import type { StateTone } from '@/components/ui/states';

/** A team connector as GET /api/connectors returns it. */
export interface RoleConnector {
  id: string;
  name: string;
  url: string | null;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  transport?: 'http' | 'stdio';
  needsReview?: boolean;
}

/** What POST /api/connectors takes for a registry entry (create or reuse by name). */
export interface ConnectorCreateInput {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  envMapping?: Record<string, string>;
  authMode?: 'none' | 'header' | 'oauth';
  reuseIfExists: true;
}

interface RegistryServer {
  server: {
    name: string;
    description: string;
    title?: string;
    version: string;
    repository?: { url: string; source: string };
    remotes?: { type: string; url: string }[];
    packages?: { registryType: string; identifier: string; transport: string[]; environmentVariables?: { name: string; description: string }[] }[];
  };
}

/** `io.github/user-repo` → `user-repo`. */
function shortName(registryName: string): string {
  const parts = registryName.split('/');
  return parts[parts.length - 1] || registryName;
}

/**
 * A registry entry as a connector: a remote is http (auth is probed
 * server-side); an npm package is stdio with each declared env var mapped to
 * a secret label of the same name; neither is an http placeholder to finish.
 */
export function registryToConnectorInput(entry: RegistryServer['server']): ConnectorCreateInput {
  const name = shortName(entry.name);
  const remote = entry.remotes?.[0];
  if (remote) return { name, transport: 'http', url: remote.url, reuseIfExists: true };
  const pkg = entry.packages?.find(p => p.registryType === 'npm');
  if (pkg) {
    const envMapping: Record<string, string> = {};
    for (const ev of pkg.environmentVariables || []) envMapping[ev.name] = ev.name;
    return { name, transport: 'stdio', command: 'npx', args: ['-y', pkg.identifier], envMapping, authMode: 'none', reuseIfExists: true };
  }
  return { name, transport: 'http', reuseIfExists: true };
}

/** Connection state in words, as Settings › Connectors says it. */
function connectionState(c: RoleConnector): { tone: StateTone; label: string } {
  if (c.authMode === 'none') return { tone: 'q', label: 'Public' };
  if (c.status === 'connected') return { tone: 'ok', label: 'Connected' };
  if (c.status === 'expired') return { tone: 'dec', label: 'Sign-in expired' };
  return { tone: 'q', label: 'Not connected' };
}

const HEALTH: Record<string, { tone: StateTone; label: string; title?: string }> = {
  ok: { tone: 'ok', label: 'Healthy' },
  auth_expired: { tone: 'dec', label: 'Sign-in expired' },
  blocked: { tone: 'bad', label: 'Blocked', title: "Blocked by your team's connector policy. Agents can't use it; the saved connection is kept." },
  server_unreachable: { tone: 'bad', label: 'Unreachable' },
};

function RegistryBrowser({ onAdd, addedNames, adding }: {
  onAdd: (input: ConnectorCreateInput) => void;
  addedNames: string[];
  adding: string | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setSearched(false); return; }
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/mcp/registry?search=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) setResults(((await res.json()) as { servers?: RegistryServer[] }).servers || []);
    } catch {
      // The list just stays empty.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  return (
    <div className="mb-3">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (debounce.current) clearTimeout(debounce.current);
          const v = e.target.value;
          debounce.current = setTimeout(() => search(v), 300);
        }}
        placeholder="Search the MCP Registry, for example github or postgres"
        className="w-full min-h-11 md:min-h-0 px-2.5 py-1.5 border border-border-default rounded-md text-base md:text-sm bg-surface-1 text-text-primary"
      />
      {loading && <p className="mt-2 text-sm text-text-muted">Searching…</p>}
      {!loading && searched && results.length === 0 && <p className="mt-2 text-sm text-text-muted">No servers found.</p>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-[280px] overflow-y-auto divide-y divide-border-default border-y border-border-default">
          {results.map(({ server: s }) => {
            const name = shortName(s.name);
            const added = addedNames.includes(name);
            return (
              <li key={s.name + s.version} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary truncate">{s.title || name}</div>
                  <p className="text-sm text-text-muted line-clamp-2">{s.description}</p>
                  <p className="text-xs text-text-muted">
                    {[s.remotes?.length ? 'Remote' : null, s.packages?.some(p => p.registryType === 'npm') ? 'npm package' : null, `v${s.version}`].filter(Boolean).join(' · ')}
                    {s.repository && <> · <a href={s.repository.url} target="_blank" rel="noopener noreferrer" className="underline">Source</a></>}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={added || adding === name}
                  onClick={() => onAdd(registryToConnectorInput(s))}
                  className="btn btn-sm h-11 md:h-7 shrink-0"
                >
                  {added ? 'Added' : adding === name ? 'Adding…' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Which team connectors (MCP servers) this role mounts at run time, saved as
 * the role's connectorRefs. For a workspace role it also says whether each
 * connector is enabled for that workspace (both are needed to mount it) and
 * can check health there; a team role has no one workspace to check against.
 */
export function RoleConnectorsSection({ teamId, workspaceId, workspaceName, roleSlug, value, onChange, disabled = false }: {
  teamId: string;
  workspaceId: string | null;
  workspaceName?: string;
  roleSlug: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [connectors, setConnectors] = useState<RoleConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabledHere, setEnabledHere] = useState<Set<string> | null>(null);
  const [health, setHealth] = useState<Map<string, string>>(new Map());
  const [checking, setChecking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [teamRes, wsRes] = await Promise.all([
          fetch(`/api/connectors?teamId=${encodeURIComponent(teamId)}`),
          workspaceId ? fetch(`/api/workspaces/${workspaceId}/connectors`) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (teamRes.ok) setConnectors(((await teamRes.json()) as { connectors?: RoleConnector[] }).connectors ?? []);
        if (wsRes?.ok) setEnabledHere(new Set((((await wsRes.json()) as { connectors?: { id: string }[] }).connectors ?? []).map(c => c.id)));
      } catch {
        // The list just stays empty.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [teamId, workspaceId]);

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(c => c !== id) : [...value, id]);

  async function checkHealth() {
    if (!workspaceId || checking) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/connector-health?roleSlug=${encodeURIComponent(roleSlug)}`);
      if (res.ok) {
        const data = (await res.json()) as { connectors?: { connectorId: string; status: string }[] };
        setHealth(new Map((data.connectors ?? []).map(c => [c.connectorId, c.status])));
      }
    } catch {
      // Best effort: nothing changes on screen.
    } finally {
      setChecking(false);
    }
  }

  async function installConnector(input: ConnectorCreateInput) {
    setAdding(input.name);
    setError(null);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({})) as { connector?: RoleConnector; error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn't add the connector");
      const created = data.connector;
      if (created?.id) {
        setConnectors(prev => (prev.some(c => c.id === created.id) ? prev : [...prev, created]));
        if (!value.includes(created.id)) onChange([...value, created.id]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the connector");
    } finally {
      setAdding(null);
    }
  }

  const addedNames = connectors.filter(c => value.includes(c.id)).map(c => c.name);

  return (
    <Section
      title="Connectors"
      action={disabled ? undefined : (
        <span className="flex items-center gap-3 text-sm">
          {workspaceId && value.length > 0 && (
            <button type="button" onClick={checkHealth} disabled={checking} className="min-h-11 md:min-h-0 text-text-secondary hover:text-text-primary disabled:opacity-50">
              {checking ? 'Checking…' : health.size > 0 ? 'Check again' : 'Check health'}
            </button>
          )}
          <button type="button" onClick={() => setBrowsing(b => !b)} className="min-h-11 md:min-h-0 text-text-secondary hover:text-text-primary">
            {browsing ? 'Hide registry' : 'Browse registry'}
          </button>
        </span>
      )}
    >
      <p className="mb-2 text-sm text-text-muted">Team MCP servers this role mounts when it runs.</p>
      {error && <p role="alert" className="mb-2 text-sm text-status-error">{error}</p>}
      {browsing && !disabled && <RegistryBrowser onAdd={installConnector} addedNames={addedNames} adding={adding} />}
      {loading && <p className="text-sm text-text-muted">Loading connectors…</p>}
      {!loading && connectors.length === 0 && (
        <p className="text-sm text-text-muted">No team connectors. Browse the registry, or add one in Settings › Connectors.</p>
      )}
      {connectors.length > 0 && (
        <ul className="divide-y divide-border-default border-y border-border-default">
          {connectors.map(c => {
            const on = value.includes(c.id);
            const state = connectionState(c);
            const h = health.get(c.id);
            const hs = h ? (HEALTH[h] ?? { tone: 'q' as StateTone, label: 'Not set up' }) : null;
            const notHere = enabledHere !== null && !enabledHere.has(c.id);
            return (
              <li key={c.id} className="py-2">
                <label className="flex min-h-11 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    data-connector={c.name}
                    checked={on}
                    disabled={disabled}
                    onChange={() => toggle(c.id)}
                    className="rounded border-border-default"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text-primary truncate">
                      {c.name}{c.transport === 'stdio' && <span className="font-normal text-text-muted"> · local command</span>}
                    </span>
                    {c.url && <span className="block text-xs text-text-muted truncate">{c.url}</span>}
                    {enabledHere !== null && (
                      <span className="block text-xs text-text-muted">{notHere ? 'Not enabled for this workspace' : 'Enabled for this workspace'}</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {c.needsReview && <TonePill tone="dec">Needs review</TonePill>}
                    <TonePill tone={state.tone}>{state.label}</TonePill>
                    {hs && <TonePill tone={hs.tone} title={hs.title}>{hs.label}</TonePill>}
                  </span>
                </label>
                {on && notHere && (
                  <p className="ml-7 text-xs text-text-muted">
                    Enable it for {workspaceName ?? 'this workspace'} in Settings › Connectors to mount it there.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
