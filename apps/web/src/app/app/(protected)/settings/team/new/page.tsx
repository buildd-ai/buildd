'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import SettingsPage from '../../_components/SettingsPage';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';

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
      router.push(`/app/settings/team?team=${encodeURIComponent(team.id)}`);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const input = 'w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm';

  return (
    <SettingsPage title="New team" description="A team shares workspaces, roles and keys between its members.">
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <Notice tone="err">{error}</Notice>}

        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-text-primary">
            Team name
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
            className={input}
          />
        </div>

        <div>
          <label htmlFor="slug" className="mb-1.5 block text-sm font-medium text-text-primary">
            Team slug
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
            className={`${input} font-mono`}
          />
          <p className="mt-1 text-sm text-text-muted">
            Lowercase letters, numbers, and hyphens only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PrimaryAction type="submit" disabled={!name || !slug} pending={loading}>
            {loading ? 'Creating…' : 'Create team'}
          </PrimaryAction>
          <Link href="/app/settings/team" className="btn btn-lg h-11 md:h-10">
            Cancel
          </Link>
        </div>
      </form>
    </SettingsPage>
  );
}
