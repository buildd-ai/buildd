'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

export function SkillForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');

  function handleNameChange(val: string) {
    setName(val);
    if (!slugEdited) {
      setSlug(generateSlug(val));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim() || undefined,
          description: description.trim() || undefined,
          content: content.trim(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create skill');
      }

      router.push(`/app/workspaces/${workspaceId}/skills`);
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-gray-200 dark:border-gray-800 rounded-lg p-6 space-y-4 bg-gray-50 dark:bg-gray-900/50">
      <h2 className="text-lg font-semibold">Register Skill</h2>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="e.g. Code Review Standards"
            required
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Slug</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => { setSlug(e.target.value); setSlugEdited(true); }}
            placeholder="auto-generated"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm font-mono"
          />
          <p className="text-xs text-gray-500 mt-1">Used in .claude/skills/{slug}/SKILL.md</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description for discovery"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">SKILL.md Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# My Skill&#10;&#10;Instructions for the agent when this skill is activated..."
          required
          rows={12}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm font-mono"
        />
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={loading || !name.trim() || !content.trim()}
          className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50 text-sm"
        >
          {loading ? 'Creating...' : 'Register Skill'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/app/workspaces/${workspaceId}/skills`)}
          className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
