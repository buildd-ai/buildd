'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function NewTeamPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const finalSlug = slug || slugify(name);

    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug: finalSlug }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create team');
      }

      const team = await res.json();
      router.push(`/app/teams/${team.id}`);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/app/settings" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
          &larr; Settings
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Team</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-2">
              Team Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              placeholder="My Team"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) {
                  setSlug(slugify(e.target.value));
                }
              }}
              className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1"
            />
          </div>

          <div>
            <label htmlFor="slug" className="block text-sm font-medium mb-2">
              Team Slug
            </label>
            <input
              type="text"
              id="slug"
              name="slug"
              required
              placeholder="my-team"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
              className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
            />
            <p className="text-xs text-text-secondary mt-1">
              Lowercase letters, numbers, and hyphens only. Used in URLs.
            </p>
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading || !name || !slug}
              className="flex-1 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Team'}
            </button>
            <Link
              href="/app/settings"
              className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
