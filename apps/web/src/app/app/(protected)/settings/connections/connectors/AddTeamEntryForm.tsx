'use client';

import { useState } from 'react';
import Notice from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';

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
 * A team admin adds an app private to the team (an internal MCP server) to
 * the catalog. The server checks it is reachable before saving.
 */
export default function AddTeamEntryForm({ onAdded }: { onAdded: () => void | Promise<void> }) {
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
