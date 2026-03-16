'use client';

import { useState } from 'react';
import Link from 'next/link';

const MODEL_LABELS: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  inherit: 'Inherit',
};

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  source: string | null;
  enabled: boolean;
  origin: string;
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  color: string;
  createdAt: string;
}

interface Props {
  workspaceId: string;
  initialSkills: Skill[];
}

export function SkillList({ workspaceId, initialSkills }: Props) {
  const [skills, setSkills] = useState(initialSkills);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSkills = searchQuery.trim()
    ? skills.filter(s =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : skills;

  async function toggleEnabled(skill: Skill) {
    setToggling(skill.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });

      if (res.ok) {
        const data = await res.json();
        setSkills((prev) =>
          prev.map((s) => (s.id === skill.id ? data.skill : s))
        );
      }
    } catch {
      // Silent failure
    } finally {
      setToggling(null);
    }
  }

  async function deleteSkill(id: string) {
    if (!confirm('Delete this skill? This cannot be undone.')) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setSkills((prev) => prev.filter((s) => s.id !== id));
      }
    } catch {
      // Silent failure
    } finally {
      setDeleting(null);
    }
  }

  if (skills.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted">
        <p className="text-lg mb-2">No roles yet</p>
        <p className="text-sm mb-3">Create roles to define agent personas with specific models, tools, and delegation rules.</p>
        <a
          href="https://docs.buildd.dev/docs/features/skills"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline"
        >
          Learn more about roles &rarr;
        </a>
      </div>
    );
  }

  return (
    <div>
      {skills.length > 3 && (
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search roles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        </div>
      )}

      <div className="border border-border-default rounded-lg divide-y divide-border-default">
        {filteredSkills.map((skill) => {
          const modelLabel = MODEL_LABELS[skill.model] || skill.model;
          const toolCount = skill.allowedTools?.length || 0;
          const delegateCount = skill.canDelegateTo?.length || 0;

          return (
            <div key={skill.id} className="flex items-center gap-3 p-4 hover:bg-surface-2/50 transition-colors">
              {/* Color dot */}
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: skill.color || '#8A8478' }}
              />

              {/* Name + slug */}
              <Link
                href={`/app/workspaces/${workspaceId}/skills/${skill.id}`}
                className="flex-1 min-w-0"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-text-primary truncate">{skill.name}</span>
                  <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded text-text-muted">{skill.slug}</code>
                </div>
                {skill.description && (
                  <p className="text-[12px] text-text-muted mt-0.5 line-clamp-1">{skill.description}</p>
                )}
              </Link>

              {/* Model badge */}
              <span className="px-2 py-0.5 text-[11px] rounded bg-surface-3 text-text-secondary font-mono flex-shrink-0">
                {modelLabel}
              </span>

              {/* Tool count */}
              {toolCount > 0 && (
                <span className="text-[11px] text-text-muted flex-shrink-0">
                  {toolCount} tool{toolCount !== 1 ? 's' : ''}
                </span>
              )}

              {/* Delegate count */}
              {delegateCount > 0 && (
                <span className="text-[11px] text-text-muted flex-shrink-0">
                  {delegateCount} delegate{delegateCount !== 1 ? 's' : ''}
                </span>
              )}

              {/* Enable/Disable toggle */}
              <button
                type="button"
                role="switch"
                aria-checked={skill.enabled}
                onClick={() => toggleEnabled(skill)}
                disabled={toggling === skill.id}
                className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
                  skill.enabled ? 'bg-status-success' : 'bg-surface-4'
                } ${toggling === skill.id ? 'opacity-50' : ''}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                  skill.enabled ? 'translate-x-4' : ''
                }`} />
              </button>

              {/* Delete */}
              <button
                onClick={() => deleteSkill(skill.id)}
                disabled={deleting === skill.id}
                className="p-1.5 text-text-muted hover:text-status-error flex-shrink-0"
                title="Delete"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {searchQuery && filteredSkills.length === 0 && (
        <p className="text-center py-6 text-text-muted text-sm">No roles match &quot;{searchQuery}&quot;</p>
      )}
    </div>
  );
}
