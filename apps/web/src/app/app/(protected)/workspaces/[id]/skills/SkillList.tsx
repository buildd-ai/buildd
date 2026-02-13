'use client';

import { useState } from 'react';

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  source: string | null;
  enabled: boolean;
  origin: 'scan' | 'manual' | 'promoted';
  createdAt: string;
}

interface Props {
  workspaceId: string;
  initialSkills: Skill[];
}

const originBadge: Record<string, { bg: string; text: string }> = {
  scan: { bg: 'bg-status-warning/10', text: 'text-status-warning' },
  manual: { bg: 'bg-primary/10', text: 'text-primary' },
  promoted: { bg: 'bg-status-success/10', text: 'text-status-success' },
};

export function SkillList({ workspaceId, initialSkills }: Props) {
  const [skills, setSkills] = useState(initialSkills);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);

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

  async function promoteSkill(skill: Skill) {
    setPromoting(skill.id);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skill.id}/promote`, {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        setSkills((prev) =>
          prev.map((s) => (s.id === skill.id ? { ...s, origin: 'promoted' as const, skillId: data.skill?.id } : s))
        );
      }
    } catch {
      // Silent failure
    } finally {
      setPromoting(null);
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
        <p className="text-lg mb-2">No skills registered</p>
        <p className="text-sm">Register a skill to make reusable agent instructions available to workers.</p>
      </div>
    );
  }

  return (
    <div className="border border-border-default rounded-lg divide-y divide-border-default">
      {skills.map((skill) => {
        const badge = originBadge[skill.origin] || originBadge.manual;
        return (
          <div key={skill.id} className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium truncate">{skill.name}</h3>
                  <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded text-text-muted">{skill.slug}</code>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${badge.bg} ${badge.text}`}>
                    {skill.origin}
                  </span>
                  {!skill.enabled && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-surface-3 text-text-secondary">
                      Disabled
                    </span>
                  )}
                </div>
                {skill.description && (
                  <p className="text-sm text-text-muted mt-0.5 line-clamp-1">{skill.description}</p>
                )}
                <div className="flex items-center gap-4 mt-1 text-xs text-text-muted">
                  {skill.source && <span>Source: {skill.source}</span>}
                  <span>{new Date(skill.createdAt).toLocaleDateString()}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-4">
                {/* Enable/Disable toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={skill.enabled}
                  onClick={() => toggleEnabled(skill)}
                  disabled={toggling === skill.id}
                  className={`relative w-10 h-6 rounded-full transition-colors ${
                    skill.enabled ? 'bg-status-success' : 'bg-surface-4'
                  } ${toggling === skill.id ? 'opacity-50' : ''}`}
                >
                  <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                    skill.enabled ? 'translate-x-4' : ''
                  }`} />
                </button>

                {/* Promote to team */}
                {skill.origin !== 'promoted' && (
                  <button
                    onClick={() => promoteSkill(skill)}
                    disabled={promoting === skill.id}
                    className="p-1.5 text-text-muted hover:text-status-success"
                    title="Promote to team skill"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}

                {/* Delete */}
                <button
                  onClick={() => deleteSkill(skill.id)}
                  disabled={deleting === skill.id}
                  className="p-1.5 text-text-muted hover:text-status-error"
                  title="Delete"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
