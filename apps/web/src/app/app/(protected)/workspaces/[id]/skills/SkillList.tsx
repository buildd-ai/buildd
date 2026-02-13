'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  enabled: boolean;
  createdAt: string;
}

export function SkillList({
  workspaceId,
  initialSkills,
}: {
  workspaceId: string;
  initialSkills: Skill[];
}) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function toggleEnabled(skill: Skill) {
    setTogglingId(skill.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      if (res.ok) {
        setSkills(prev => prev.map(s =>
          s.id === skill.id ? { ...s, enabled: !s.enabled } : s
        ));
      }
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteSkill(skill: Skill) {
    if (!confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return;
    setDeletingId(skill.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSkills(prev => prev.filter(s => s.id !== skill.id));
      }
    } finally {
      setDeletingId(null);
    }
  }

  if (skills.length === 0) {
    return (
      <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
        <p className="text-gray-500 mb-2">No skills registered yet</p>
        <p className="text-sm text-gray-400">
          Skills are SKILL.md instruction packages that agents receive when they claim tasks.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {skills.map((skill) => (
        <div
          key={skill.id}
          className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden"
        >
          <div className="flex items-center justify-between p-4">
            <div
              className="flex-1 cursor-pointer"
              onClick={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
            >
              <div className="flex items-center gap-3">
                <h3 className="font-medium">{skill.name}</h3>
                <code className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
                  {skill.slug}
                </code>
                <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
                  {skill.source}
                </span>
                {!skill.enabled && skill.source === 'local_scan' && (
                  <span className="text-xs px-2 py-0.5 rounded bg-orange-100 dark:bg-orange-500/15 text-orange-600 dark:text-orange-400 font-medium">
                    Pending Review
                  </span>
                )}
              </div>
              {skill.description && (
                <p className="text-sm text-gray-500 mt-1">{skill.description}</p>
              )}
            </div>

            <div className="flex items-center gap-3 ml-4">
              {/* Enable/Disable toggle */}
              <button
                onClick={() => toggleEnabled(skill)}
                disabled={togglingId === skill.id}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  skill.enabled
                    ? 'bg-green-500'
                    : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    skill.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>

              {/* Delete button */}
              <button
                onClick={() => deleteSkill(skill)}
                disabled={deletingId === skill.id}
                className="text-red-500 hover:text-red-700 text-sm disabled:opacity-50"
              >
                {deletingId === skill.id ? '...' : 'Delete'}
              </button>
            </div>
          </div>

          {/* Expandable content preview */}
          {expandedId === skill.id && (
            <div className="border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-gray-500 font-medium">SKILL.md</span>
                <span className="text-xs text-gray-400">
                  .claude/skills/{skill.slug}/SKILL.md
                </span>
              </div>
              <pre className="text-sm whitespace-pre-wrap font-mono text-gray-700 dark:text-gray-300 max-h-64 overflow-y-auto">
                {skill.content}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
