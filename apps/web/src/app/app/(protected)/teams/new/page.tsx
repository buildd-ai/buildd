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
        <Link href="/app/teams" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; Teams
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Team</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
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
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
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
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Lowercase letters, numbers, and hyphens only. Used in URLs.
            </p>
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading || !name || !slug}
              className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Team'}
            </button>
            <Link
              href="/app/teams"
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
