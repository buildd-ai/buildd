'use client';

import { useState } from 'react';
import Link from 'next/link';
import { roleModelLabel } from '@/lib/model-presentation';
import { SUBAGENT_TOOLS_NOTE, subagentToolsSummary } from '@/lib/role-tool-scope';
import { useConfirm } from '@/components/useConfirm';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';

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
  const { confirm, confirmDialog } = useConfirm();
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
    if (!(await confirm({ title: 'Delete skill?', message: 'You can\'t undo this.', confirmLabel: 'Delete', variant: 'danger' }))) return;
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
        <p className="text-sm mb-3">A role sets an agent&apos;s model, tools, and who it can delegate to.</p>
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
            placeholder="Search roles…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        </div>
      )}

      <div className="border border-border-default rounded-lg divide-y divide-border-default">
        {filteredSkills.map((skill) => {
          const modelLabel = roleModelLabel(skill.model);
          const toolCount = skill.allowedTools?.length || 0;
          const delegateCount = skill.canDelegateTo?.length || 0;

          return (
            <div key={skill.id} className="flex items-center gap-2 sm:gap-3 p-3 sm:p-4 hover:bg-surface-2/50 transition-colors">
              {/* Color dot */}
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: skill.color || '#8A8478' }}
              />

              {/* Name + meta. Below sm the meta drops to its own line so the
                  name keeps the width and the actions stay on-screen at 320px. */}
              <div className="flex-1 min-w-0 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <Link
                  href={`/app/workspaces/${workspaceId}/skills/${skill.id}`}
                  className="min-w-0 sm:flex-1"
                  data-testid="skill-row-link"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-text-primary truncate">{skill.name}</span>
                    <code className="hidden sm:inline text-xs bg-surface-3 px-1.5 py-0.5 rounded text-text-muted flex-shrink-0">{skill.slug}</code>
                  </div>
                  {skill.description && (
                    <p className="text-[12px] text-text-muted mt-0.5 line-clamp-1">{skill.description}</p>
                  )}
                </Link>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap sm:flex-shrink-0">
                  {/* Model badge */}
                  <span className="px-2 py-0.5 text-[11px] rounded bg-surface-3 text-text-secondary font-mono flex-shrink-0">
                    {modelLabel}
                  </span>

                  {/* Subagent tool count — scoped, not a restriction on the role's agent */}
                  {toolCount > 0 && (
                    <span className="text-[11px] text-text-muted flex-shrink-0" title={SUBAGENT_TOOLS_NOTE}>
                      {subagentToolsSummary(skill.allowedTools)}
                    </span>
                  )}

                  {/* Delegate count */}
                  {delegateCount > 0 && (
                    <span className="text-[11px] text-text-muted flex-shrink-0">
                      {delegateCount} delegate{delegateCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Enable/Disable toggle */}
              <Switch
                checked={skill.enabled}
                onChange={() => toggleEnabled(skill)}
                disabled={toggling === skill.id}
                label={`Enable ${skill.name}`}
                className={SWITCH_HIT_AREA}
              />

              {/* Delete */}
              <button
                onClick={() => deleteSkill(skill.id)}
                disabled={deleting === skill.id}
                className="inline-flex items-center justify-center min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 text-text-muted hover:text-status-error flex-shrink-0"
                title="Delete"
                aria-label={`Delete ${skill.name}`}
              >
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
      {confirmDialog}
    </div>
  );
}
