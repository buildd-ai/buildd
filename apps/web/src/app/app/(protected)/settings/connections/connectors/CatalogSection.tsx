'use client';

import { useCallback, useEffect, useState } from 'react';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import Disclosure from '@/components/ui/Disclosure';
import { TonePill } from '@/components/ui/StatePill';
import { Select } from '@/components/ui/Select';
import { ConnectorIcon } from '@/components/ConnectorIcon';
import { CATALOG_POLICIES, type CatalogPolicy, type ConnectorClientSupport, type ResolvedCatalogEntry } from '@/lib/connector-catalog';

const POLICY_LABEL: Record<CatalogPolicy, string> = {
  blocked: 'Blocked',
  available: 'Available',
  preinstalled: 'Preinstalled',
};

const CATEGORY_OPTIONS = [
  { value: 'other', label: 'Other' },
  { value: 'deploy', label: 'Deploy' },
  { value: 'database', label: 'Database' },
  { value: 'observability', label: 'Observability' },
  { value: 'project', label: 'Project' },
  { value: 'docs', label: 'Docs' },
  { value: 'analytics', label: 'Analytics' },
];

type AuthChoice = 'oauth' | 'none' | 'header';

const inputClass =
  'w-full px-3 py-2 bg-surface-3 border border-border-default text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary';

/**
 * Settings → MCP connectors → Catalog. Team admins decide, per catalog entry,
 * whether it is blocked, available in Add connection, or preinstalled into
 * every workspace; and add entries private to the team. Members see nothing
 * here (they use Add connection).
 */
export default function CatalogSection() {
  const [entries, setEntries] = useState<ResolvedCatalogEntry[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors/catalog');
      if (!res.ok) return;
      const data = await res.json() as { canManage?: boolean; entries?: ResolvedCatalogEntry[] };
      setCanManage(!!data.canManage);
      setEntries(data.entries ?? []);
    } catch {
      /* section stays hidden */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setPolicy(entry: ResolvedCatalogEntry, policy: CatalogPolicy) {
    if (policy === entry.policy) return;
    setSaving(entry.slug);
    setMessage(null);
    try {
      const res = await fetch('/api/connectors/catalog/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: entry.slug, policy }),
      });
      const data = await res.json().catch(() => ({})) as { message?: string; error?: string; retainedConnectorIds?: string[] };
      if (!res.ok) {
        setMessage({ type: 'err', text: data.message || data.error || `Could not update ${entry.name}.` });
        return;
      }
      setEntries((prev) => prev.map((e) => (e.slug === entry.slug ? { ...e, policy } : e)));
      if (policy === 'preinstalled') setMessage({ type: 'ok', text: `${entry.name} is now in every workspace.` });
      if (policy === 'blocked' && data.retainedConnectorIds?.length) {
        setMessage({ type: 'ok', text: `Agents can no longer use ${entry.name}. Your saved connection is kept, so unblocking restores it.` });
      }
    } catch {
      setMessage({ type: 'err', text: `Could not update ${entry.name}.` });
    } finally {
      setSaving(null);
    }
  }

  async function remove(entry: ResolvedCatalogEntry) {
    if (!entry.id) return;
    setSaving(entry.slug);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/catalog/${entry.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string; error?: string };
        setMessage({ type: 'err', text: data.message || data.error || `Could not remove ${entry.name}.` });
        return;
      }
      await load();
    } finally {
      setSaving(null);
    }
  }

  if (!loaded || !canManage) return null;

  return (
    <Section
      title="Catalog"
      action={
        <button type="button" className="btn btn-sm" onClick={() => setShowAdd((v) => !v)} data-testid="catalog-add-toggle">
          {showAdd ? 'Cancel' : 'Add team entry'}
        </button>
      }
    >
      {message && (
        <Notice tone={message.type === 'ok' ? 'ok' : 'err'} className="mb-3" data-testid="catalog-message">
          {message.text}
        </Notice>
      )}

      {showAdd && (
        <AddTeamEntryForm
          onAdded={async () => { setShowAdd(false); await load(); }}
        />
      )}

      {/* The per-row Blocked / Available / Preinstalled seg stays as is: the
          owner has not decided whether it becomes a select. */}
      <ul className="divide-y divide-border-default">
        {entries.map((entry) => (
          <li key={entry.slug} className="py-3" data-testid={`catalog-entry-${entry.slug}`}>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-3 sm:gap-4">
              <div className="flex-1 min-w-0 flex items-start gap-3">
                <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} size={20} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-primary">{entry.name}</span>
                    {/* Only a team's own entries are tagged; built-in is the default. */}
                    {entry.source === 'team' && <TonePill tone="q">Team</TonePill>}
                  </div>
                  {entry.description && <div className="text-xs text-text-secondary mt-0.5">{entry.description}</div>}
                  {entry.policy === 'preinstalled' && (
                    <div className="text-xs text-text-secondary mt-1">
                      Added to every workspace. Roles still choose which connectors they use.
                    </div>
                  )}
                  {entry.policy === 'blocked' && (
                    <div className="text-xs text-text-secondary mt-1">
                      Agents can&apos;t use it, even where it&apos;s already connected. Connections are kept.
                    </div>
                  )}
                  {entry.clientSupport && <ClientSupportNote support={entry.clientSupport} />}
                  <Disclosure summary={<span className="text-xs">Details</span>} className="mt-1">
                    <p className="pb-1 text-xs text-text-muted font-mono break-all">{entry.url}</p>
                  </Disclosure>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:flex-shrink-0 sm:justify-end">
                <div className="seg inline-flex" role="radiogroup" aria-label={`${entry.name} policy`}>
                  {CATALOG_POLICIES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={entry.policy === p}
                      disabled={saving === entry.slug}
                      onClick={() => setPolicy(entry, p)}
                      data-testid={`catalog-policy-${entry.slug}-${p}`}
                      className={`seg-item ${entry.policy === p ? 'seg-item-active' : ''}`}
                    >
                      {POLICY_LABEL[p]}
                    </button>
                  ))}
                </div>
                {entry.source === 'team' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={saving === entry.slug}
                    onClick={() => remove(entry)}
                    data-testid={`catalog-remove-${entry.slug}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The provider won't let buildd sign in yet: say so, and where the owner fixes
 * it. Not a decision for this page, so a muted info notice, never orange.
 */
export function ClientSupportNote({ support }: { support: ConnectorClientSupport }) {
  return (
    <Notice tone="info" className="mt-2 text-xs" data-testid="connector-client-support">
      {support.detail}{' '}
      <a href={support.actionUrl} target="_blank" rel="noreferrer" className="underline">
        {support.actionLabel}
      </a>
    </Notice>
  );
}

function AddTeamEntryForm({ onAdded }: { onAdded: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<AuthChoice>('oauth');
  const [headerName, setHeaderName] = useState('Authorization');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/connectors/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          authMode: auth,
          ...(auth === 'header' ? { headerName: headerName.trim() } : {}),
          description: description.trim(),
          category,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string; error?: string };
        setError(data.message || data.error || 'Could not add the entry.');
        return;
      }
      await onAdded();
    } catch {
      setError('Could not add the entry.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 mb-3 space-y-3" data-testid="catalog-add-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="field-label">Name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal tools" />
        </label>
        <label className="block">
          <span className="field-label">URL</span>
          <input className={inputClass} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="field-label !mb-0">Auth</span>
        <div className="seg inline-flex" role="radiogroup" aria-label="Auth">
          {([['oauth', 'OAuth'], ['none', 'No auth'], ['header', 'API key header']] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={auth === v}
              onClick={() => setAuth(v)}
              data-testid={`catalog-add-auth-${v}`}
              className={`seg-item ${auth === v ? 'seg-item-active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {auth === 'header' && (
        <label className="block">
          <span className="field-label">Header name</span>
          <input className={inputClass} value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
        </label>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="field-label">Description</span>
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What agents use it for" />
        </label>
        <div>
          <span className="field-label">Category</span>
          <Select aria-label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
        </div>
      </div>
      {error && <Notice tone="err" data-testid="catalog-add-error">{error}</Notice>}
      <div className="flex justify-end">
        <button type="submit" className="btn btn-primary" disabled={submitting || !name.trim() || !url.trim()}>
          {submitting ? 'Checking…' : 'Add to catalog'}
        </button>
      </div>
    </form>
  );
}
