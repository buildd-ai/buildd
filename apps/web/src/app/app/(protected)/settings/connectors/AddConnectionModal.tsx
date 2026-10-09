'use client';

import { useState, useEffect, useRef } from 'react';
import { ScopeSelector, type ShareScope } from '@/components/ScopeSelector';
import { ConnectorIcon } from '@/components/ConnectorIcon';
import { roleHas, type PermissionOverrides } from '@/lib/permission-registry';
import { CONNECTOR_CATALOG, catalogEntryForUrl, normalizeConnectorUrl, type ConnectorCatalogEntry, type ResolvedCatalogEntry } from '@/lib/connector-catalog';

interface CreatedConnector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  headerName?: string | null;
  iconUrl?: string | null;
}

interface AddConnectionModalProps {
  onClose: () => void;
  onAdded: (connector: CreatedConnector) => void;
  /** URLs of connectors the team already has — their catalog tiles show "Added". */
  existingUrls?: string[];
}

type Step = 'catalog' | 'form' | 'discovered';

export default function AddConnectionModal({ onClose, onAdded, existingUrls = [] }: AddConnectionModalProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState<ConnectorCatalogEntry | null>(null);
  const [headerValue, setHeaderValue] = useState('');
  const [step, setStep] = useState<Step>('catalog');
  const [createdConnector, setCreatedConnector] = useState<CreatedConnector & { discoveredAuthMode?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Scope control — mirrors AgentBackendsSection (docs/design/unified-sharing-model.md)
  const [scope, setScope] = useState<ShareScope>('team');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (step === 'form' && !preset) nameRef.current?.focus();
  }, [step, preset]);

  // The team's live catalog (built-in + platform + team entries with policy).
  // Until it loads, or if it fails, the built-ins stand in.
  const [catalog, setCatalog] = useState<ResolvedCatalogEntry[]>(() =>
    CONNECTOR_CATALOG.map((e) => ({ ...e, id: null, source: 'builtin' as const, policy: 'available' as const })),
  );
  useEffect(() => {
    let cancelled = false;
    fetch('/api/connectors/catalog')
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json() as { entries?: ResolvedCatalogEntry[] };
        if (!cancelled && Array.isArray(data.entries)) setCatalog(data.entries);
      })
      .catch(() => { /* keep built-ins */ });
    return () => { cancelled = true; };
  }, []);
  const offered = catalog.filter((e) => e.policy !== 'blocked');

  const existing = new Set(existingUrls.map((u) => normalizeConnectorUrl(u)).filter((s): s is string => !!s));
  const installed = new Set(
    offered.filter((e) => {
      const key = normalizeConnectorUrl(e.url);
      return (key && existing.has(key)) || existingUrls.some((u) => catalogEntryForUrl(u)?.slug === e.slug && e.source === 'builtin');
    }).map((e) => e.slug),
  );

  // A catalog pick prefills the same create flow a custom URL uses, so OAuth
  // discovery, DCR and scope all behave identically.
  function pickPreset(entry: ConnectorCatalogEntry) {
    setPreset(entry);
    setName(entry.name);
    setUrl(entry.url);
    setError(null);
    setStep('form');
  }

  function pickCustom() {
    setPreset(null);
    setName('');
    setUrl('');
    setError(null);
    setStep('form');
  }

  useEffect(() => {
    async function loadScopeData() {
      const [wsRes, teamsRes] = await Promise.all([
        fetch('/api/workspaces'),
        fetch('/api/teams'),
      ]);
      if (wsRes.ok) {
        const data = await wsRes.json() as { workspaces?: { id: string; name: string }[] };
        const wsList = (data.workspaces ?? []).map((w) => ({ id: w.id, name: w.name }));
        setWorkspaces(wsList);
        if (wsList.length > 0) setSelectedWorkspaceId(wsList[0].id);
      }
      if (teamsRes.ok) {
        const data = await teamsRes.json() as { teams?: { id: string; name: string; role?: string | null; permissionOverrides?: PermissionOverrides | null }[] };
        // "All my teams" = teams the user manages; the shares route refuses the rest.
        setTeams((data.teams ?? []).filter((t) => roleHas(t.role, 'manage_connectors', t.permissionOverrides ?? null)));
      }
    }
    void loadScopeData();
  }, []);

  // Apply scope after connector creation:
  //   'team'      → default, connector is already team-wide, no extra step.
  //   'workspace' → enable the connector for the chosen workspace mount.
  //   'all_teams' → share with every other team the user manages.
  async function applyScope(connectorId: string, ownerTeamId: string) {
    if (scope === 'workspace' && selectedWorkspaceId) {
      await fetch(`/api/workspaces/${selectedWorkspaceId}/connectors`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId, enabled: true }),
      }).catch(() => null);
    } else if (scope === 'all_teams') {
      const toShare = teams.filter((t) => t.id !== ownerTeamId);
      await Promise.all(
        toShare.map((team) =>
          fetch(`/api/connectors/${connectorId}/shares`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ teamId: team.id }),
          }).catch(() => null),
        ),
      );
    }
  }

  // Called when user clicks "Continue" in the form step.
  // POST to /api/connectors with authMode='oauth' to trigger auto-discovery.
  async function handleDiscover(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      setError('Name and URL are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          preset?.authMode === 'header'
            ? { name: name.trim(), url: url.trim(), authMode: 'header', headerName: preset.headerName ?? 'Authorization', headerValue: headerValue.trim() }
            : preset?.authMode === 'none'
              ? { name: name.trim(), url: url.trim(), authMode: 'none' }
              : { name: name.trim(), url: url.trim() },
        ),
      });
      if (res.ok) {
        const data = await res.json() as { connector: CreatedConnector & { teamId?: string; discoveredMetadata?: Record<string, unknown> | null } };
        const connector = data.connector;
        const discoveredAuthMode = (connector.discoveredMetadata?.authMode as string) ?? 'none';

        // Apply scope (workspace mount or cross-team shares) before moving to step 2.
        if (connector.id && connector.teamId) {
          await applyScope(connector.id, connector.teamId);
        }

        // Catalog entries are known-good oauth/none servers: hand straight to the
        // parent, which starts the OAuth redirect — no confirm screen.
        if (preset?.authMode === 'header') {
          onAdded({ ...connector, authMode: 'header', status: 'connected' });
          return;
        }
        if (preset?.authMode === 'none') {
          onAdded({ ...connector, authMode: 'none', status: 'connected' });
          return;
        }
        if (preset && (discoveredAuthMode === 'oauth' || discoveredAuthMode === 'none')) {
          onAdded({ ...connector, authMode: discoveredAuthMode, status: discoveredAuthMode === 'none' ? 'connected' : 'not_connected' });
          return;
        }
        setCreatedConnector({ ...connector, discoveredAuthMode, status: 'not_connected' });
        setStep('discovered');
      } else {
        const data = await res.json() as { error?: string; message?: string };
        setError(data.message || (data.error === 'connector_name_taken' ? `A connector named "${name.trim()}" already exists.` : data.error) || 'Failed to add connection');
      }
    } catch {
      setError('Failed to add connection');
    } finally {
      setSubmitting(false);
    }
  }

  // For oauth: initiate the connect flow (redirect to authorization URL).
  async function handleConnect() {
    if (!createdConnector) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/${createdConnector.id}/connect`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { authorizationUrl: string };
        window.location.href = data.authorizationUrl;
      } else {
        const err = await res.json() as { error?: string };
        setError(err.error || 'Failed to start OAuth flow');
        setSubmitting(false);
      }
    } catch {
      setError('Failed to start OAuth flow');
      setSubmitting(false);
    }
  }

  // For header: save the header value, then signal completion.
  async function handleSaveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!createdConnector || !headerValue.trim()) {
      setError('API key is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    // We need to re-create with the header mode since the current connector is oauth mode.
    // Delete the oauth-created connector and re-POST with header mode.
    try {
      await fetch(`/api/connectors/${createdConnector.id}`, { method: 'DELETE' });
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: createdConnector.name,
          url: createdConnector.url,
          authMode: 'header',
          headerValue: headerValue.trim(),
        }),
      });
      if (res.ok) {
        const data = await res.json() as { connector: CreatedConnector & { teamId?: string } };
        // Re-apply scope on the newly created (header-mode) connector.
        if (data.connector.id && data.connector.teamId) {
          await applyScope(data.connector.id, data.connector.teamId);
        }
        onAdded({ ...data.connector, status: 'connected' });
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error || 'Failed to save API key');
      }
    } catch {
      setError('Failed to save API key');
    } finally {
      setSubmitting(false);
    }
  }

  // For none: connector already created, just close.
  function handleDone() {
    if (!createdConnector) return;
    onAdded({ ...createdConnector, authMode: 'none' });
  }

  // If user closes during step 2 without completing oauth/header, leave connector as-is.
  // It will appear as "Not connected" in the list and can be deleted.
  function handleClose() {
    onClose();
  }

  const discoveredAuthMode = createdConnector?.discoveredAuthMode ?? 'none';

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div className={`bg-surface-2 rounded-lg shadow-xl w-full ${step === 'catalog' ? 'max-w-xl' : 'max-w-md'}`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-text-primary">
              {step === 'catalog' ? 'Add connection' : preset ? `Add ${preset.name}` : 'Custom connection'}
            </h2>
            <button
              onClick={handleClose}
              className="text-text-muted hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {step === 'catalog' && (
            <div className="space-y-4" data-testid="connector-catalog">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[60vh] overflow-y-auto">
                {offered.map((entry) => {
                  const added = installed.has(entry.slug);
                  return (
                    <button
                      key={entry.slug}
                      type="button"
                      onClick={() => pickPreset(entry)}
                      disabled={added}
                      data-testid={`connector-catalog-${entry.slug}`}
                      className="flex items-start gap-3 p-3 text-left bg-surface-3 border border-border-default hover:border-primary disabled:opacity-60 disabled:hover:border-border-default transition-colors"
                    >
                      <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} size={24} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{entry.name}</span>
                          {added && <span className="text-xs font-mono text-status-success">Added</span>}
                          {entry.policy === 'preinstalled' && <span className="text-xs font-mono text-text-muted">Preinstalled</span>}
                          {entry.clientSupport && <span className="text-xs font-mono text-status-warning">Needs approval</span>}
                        </span>
                        <span className="block text-xs text-text-muted mt-0.5">{entry.description}</span>
                        {entry.clientSupport && (
                          <span className="block text-xs text-status-warning mt-1" data-testid={`connector-catalog-${entry.slug}-client-support`}>
                            {entry.clientSupport.detail}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={pickCustom}
                  data-testid="connector-catalog-custom"
                  className="flex items-start gap-3 p-3 text-left border border-dashed border-border-default hover:border-primary transition-colors"
                >
                  <ConnectorIcon name="+" size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text-primary">Custom URL</span>
                    <span className="block text-xs text-text-muted mt-0.5">Any remote MCP server. Its icon is detected automatically.</span>
                  </span>
                </button>
              </div>
              <div className="flex pt-1">
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {step === 'form' && (
            <form onSubmit={handleDiscover} className="space-y-4">
              {preset ? (
                <div className="flex items-start gap-3 px-3 py-2.5 bg-surface-3">
                  <ConnectorIcon name={preset.name} iconUrl={preset.iconUrl} size={24} />
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary">{preset.description}</div>
                    <div className="text-xs text-text-muted font-mono truncate">{preset.url}</div>
                  </div>
                </div>
              ) : null}
              {preset?.authMode === 'header' && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                    {preset.headerName || 'API key'}
                  </label>
                  <input
                    type="password"
                    value={headerValue}
                    onChange={(e) => setHeaderValue(e.target.value)}
                    placeholder="Enter your API key"
                    autoFocus
                    className="w-full px-3 py-2 bg-surface-3 border border-border-default rounded-md text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                  />
                </div>
              )}
              {!preset && (
              <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                  Name
                </label>
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My MCP Server"
                  className="w-full px-3 py-2 bg-surface-3 border border-border-default rounded-md text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                  URL
                </label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com"
                  className="w-full px-3 py-2 bg-surface-3 border border-border-default rounded-md text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                />
              </div>
              </>
              )}
              {workspaces.length > 0 && (
                <ScopeSelector
                  scope={scope}
                  onScopeChange={setScope}
                  workspaceId={selectedWorkspaceId}
                  onWorkspaceChange={setSelectedWorkspaceId}
                  workspaces={workspaces}
                  allowAllTeams={teams.length > 1}
                  allTeamsCount={teams.length}
                />
              )}
              {error && (
                <div className="px-3 py-2 rounded-md text-xs bg-status-error/10 text-status-error border border-status-error/30">
                  {error}
                </div>
              )}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setStep('catalog')}
                  className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={submitting || !name.trim() || !url.trim() || (preset?.authMode === 'header' && !headerValue.trim())}
                  className="flex-1 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  {submitting ? 'Checking…' : preset ? `Add ${preset.name}` : 'Continue'}
                </button>
              </div>
            </form>
          )}

          {step === 'discovered' && createdConnector && (
            <div className="space-y-4">
              <div className="px-3 py-2.5 bg-surface-3 rounded-md">
                <div className="text-sm font-medium text-text-primary mb-0.5">{createdConnector.name}</div>
                <div className="text-xs text-text-muted font-mono">{createdConnector.url}</div>
              </div>

              {/* Auth mode badge */}
              {discoveredAuthMode === 'oauth' && (
                <div className="px-3 py-2 rounded-md text-xs border font-mono bg-status-success/10 text-status-success border-status-success/30">
                  OAuth 2.0 detected
                </div>
              )}
              {discoveredAuthMode === 'none' && (
                <div className="px-3 py-2 rounded-md text-xs border font-mono bg-status-info/10 text-status-info border-status-info/30">
                  No auth required · connector ready
                </div>
              )}

              {/* OAuth: Connect button */}
              {discoveredAuthMode === 'oauth' && (
                <>
                  {error && (
                    <div className="px-3 py-2 rounded-md text-xs bg-status-error/10 text-status-error border border-status-error/30">
                      {error}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={handleClose}
                      className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
                    >
                      Later
                    </button>
                    <button
                      onClick={handleConnect}
                      disabled={submitting}
                      className="flex-1 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
                    >
                      {submitting ? 'Redirecting…' : 'Connect'}
                    </button>
                  </div>
                </>
              )}

              {/* No auth: Done */}
              {discoveredAuthMode === 'none' && (
                <div className="flex gap-3">
                  <button
                    onClick={handleClose}
                    className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={handleDone}
                    className="flex-1 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover transition-colors"
                  >
                    Done
                  </button>
                </div>
              )}

              {/* Header: show key field */}
              {discoveredAuthMode === 'header' && (
                <form onSubmit={handleSaveKey} className="space-y-4">
                  <div className="px-3 py-2 rounded-md text-xs border font-mono bg-status-warning/10 text-status-warning border-status-warning/30">
                    API key header detected
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                      {createdConnector.headerName || 'API Key'}
                    </label>
                    <input
                      type="password"
                      value={headerValue}
                      onChange={(e) => setHeaderValue(e.target.value)}
                      placeholder="Enter your API key"
                      autoFocus
                      className="w-full px-3 py-2 bg-surface-3 border border-border-default rounded-md text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
                    />
                  </div>
                  {error && (
                    <div className="px-3 py-2 rounded-md text-xs bg-status-error/10 text-status-error border border-status-error/30">
                      {error}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
                    >
                      Later
                    </button>
                    <button
                      type="submit"
                      disabled={submitting || !headerValue.trim()}
                      className="flex-1 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
                    >
                      {submitting ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
