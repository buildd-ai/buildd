'use client';

import { useState } from 'react';

interface Skill {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  recentRuns?: number;
}

interface Props {
  skills: Skill[];
  selectedSlugs: string[];
  onToggle: (slug: string) => void;
  useSkillAgents: boolean;
  onUseSkillAgentsChange: (value: boolean) => void;
}

export function SkillPills({ skills, selectedSlugs, onToggle, useSkillAgents, onUseSkillAgentsChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const selectedCount = selectedSlugs.length;

  if (skills.length === 0) return null;

  return (
    <div>
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-text-secondary transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        Skills
        {selectedCount > 0 && (
          <span className="inline-flex items-center justify-center w-5 h-5 text-xs rounded-full bg-primary text-white">
            {selectedCount}
          </span>
        )}
      </button>

      {/* Selected skills always visible as removable tags */}
      {!expanded && selectedCount > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {skills
            .filter(s => selectedSlugs.includes(s.slug))
            .map(skill => (
              <button
                key={skill.id}
                type="button"
                onClick={() => onToggle(skill.slug)}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                {skill.name}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ))}
        </div>
      )}

      {/* Expanded pill picker */}
      {expanded && (
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-1">
            {skills.map(skill => {
              const selected = selectedSlugs.includes(skill.slug);
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => onToggle(skill.slug)}
                  className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                    selected
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                      : 'bg-surface-3 text-text-secondary hover:text-text-primary hover:bg-surface-4'
                  }`}
                  title={skill.description || undefined}
                >
                  {skill.name}
                  {(skill.recentRuns ?? 0) > 0 && (
                    <span className="ml-1 text-[11px] opacity-60">{skill.recentRuns}</span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-text-secondary">
            Skills provide reusable instructions to the worker agent.
          </p>

          {selectedCount > 0 && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useSkillAgents}
                onChange={(e) => onUseSkillAgentsChange(e.target.checked)}
                className="mt-0.5 rounded border-border-default text-primary focus:ring-primary-ring"
              />
              <div>
                <span className="text-sm font-medium">Use skills as specialist agents</span>
                <p className="text-xs text-text-secondary mt-0.5">
                  Skills will be available as autonomous sub-agents that the worker can delegate to.
                </p>
              </div>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
