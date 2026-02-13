'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  workspaceId: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function SkillForm({ workspaceId }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');

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
          source: source || 'manual',
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to register skill');
      }

      router.push(`/app/workspaces/${workspaceId}/skills`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register skill');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="border border-border-default rounded-lg p-6">
        <h3 className="font-semibold text-lg mb-4">Register Skill</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="UI Audit"
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
              placeholder="ui-audit"
              pattern="^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
            />
            <p className="text-xs text-text-muted mt-1">
              Lowercase alphanumeric with hyphens. Auto-generated from name.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Audits UI components for accessibility and design consistency"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Content (SKILL.md)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
              placeholder="# Skill Name&#10;&#10;Instructions for the agent..."
              required
            />
            <p className="text-xs text-text-muted mt-1">
              Full skill content in markdown format. This will be provided to agents when executing tasks.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Source</label>
            <input
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="manual"
            />
            <p className="text-xs text-text-muted mt-1">
              Origin identifier (e.g., &quot;manual&quot;, &quot;github:owner/repo&quot;).
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Register Skill'}
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
