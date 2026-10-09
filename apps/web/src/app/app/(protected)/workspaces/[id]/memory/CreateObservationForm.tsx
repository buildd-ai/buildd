'use client';

import { useState } from 'react';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';

const TYPES = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'] as const;

const TYPE_DESCRIPTIONS: Record<string, string> = {
  gotcha: 'A pitfall or mistake to avoid',
  pattern: 'A solution or practice you reuse',
  decision: 'An architecture or design choice',
  discovery: 'Something you learned',
  architecture: 'How components fit together',
};

interface CreateObservationFormProps {
  workspaceId: string;
  onCreated: () => void;
}

export default function CreateObservationForm({ workspaceId, onCreated }: CreateObservationFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState<typeof TYPES[number]>('gotcha');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [filesInput, setFilesInput] = useState('');
  const [conceptsInput, setConceptsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!title.trim() || !content.trim()) {
      setError('Title and content are required');
      return;
    }

    setSaving(true);
    try {
      const files = filesInput
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
      const concepts = conceptsInput
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);

      const res = await fetch(`/api/workspaces/${workspaceId}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          content: content.trim(),
          files: files.length > 0 ? files : undefined,
          tags: concepts.length > 0 ? concepts : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create observation');
      }

      // Reset form and close
      setTitle('');
      setContent('');
      setFilesInput('');
      setConceptsInput('');
      setType('gotcha');
      setIsOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) {
    return (
      <PrimaryAction onClick={() => setIsOpen(true)}>
        Add memory
      </PrimaryAction>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card p-4 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-medium">New memory</h3>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="btn btn-sm"
        >
          Cancel
        </button>
      </div>

      {error && (
        <Notice tone="err" className="mb-4">{error}</Notice>
      )}

      <div className="space-y-4">
        {/* Type selector */}
        <div>
          <label className="block text-sm font-medium mb-1">Type</label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Type">
            {TYPES.map(t => (
              <button
                key={t}
                type="button"
                aria-pressed={type === t}
                onClick={() => setType(t)}
                className={`filter-pill ${type === t ? 'filter-pill-active' : ''}`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted mt-1">{TYPE_DESCRIPTIONS[type]}</p>
        </div>

        {/* Title */}
        <div>
          <label htmlFor="obs-title" className="block text-sm font-medium mb-1">Title</label>
          <input
            id="obs-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short title"
            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
          />
        </div>

        {/* Content */}
        <div>
          <label htmlFor="obs-content" className="block text-sm font-medium mb-1">Content</label>
          <textarea
            id="obs-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What you observed, with detail…"
            rows={4}
            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm resize-y"
          />
        </div>

        {/* Files */}
        <div>
          <label htmlFor="obs-files" className="block text-sm font-medium mb-1">
            Related files <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <input
            id="obs-files"
            type="text"
            value={filesInput}
            onChange={(e) => setFilesInput(e.target.value)}
            placeholder="src/api/auth.ts, lib/utils.ts (comma-separated)"
            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
          />
        </div>

        {/* Concepts */}
        <div>
          <label htmlFor="obs-concepts" className="block text-sm font-medium mb-1">
            Concepts or tags <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <input
            id="obs-concepts"
            type="text"
            value={conceptsInput}
            onChange={(e) => setConceptsInput(e.target.value)}
            placeholder="authentication, caching, performance (comma-separated)"
            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
          />
        </div>

        {/* Submit */}
        <div className="flex justify-end">
          <PrimaryAction type="submit" pending={saving}>
            {saving ? 'Saving…' : 'Save memory'}
          </PrimaryAction>
        </div>
      </div>
    </form>
  );
}
