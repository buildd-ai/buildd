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
  recentRuns?: number;
  totalRuns?: number;
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

const PIPELINE_SLUGS = ['pipeline-fan-out-merge', 'pipeline-sequential', 'pipeline-release'];

const WORKFLOW_CARDS = [
  { type: 'fan-out', label: 'Fan-Out & Merge', diagram: '[Task] \u2192 [1] [2] [N] \u2192 [Merge]', description: 'Break work into parallel tasks and merge results' },
  { type: 'sequential', label: 'Sequential', diagram: '[1] \u2192 [2] \u2192 [3]', description: 'Chain tasks where each waits for the previous' },
  { type: 'release', label: 'Release', diagram: '[Test] [Lint] [Type] \u2192 [Release]', description: 'Parallel validation followed by guarded release' },
];

export function SkillList({ workspaceId, initialSkills }: Props) {
  const [skills, setSkills] = useState(initialSkills);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', content: '', source: '' });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const isEditable = (skill: Skill) => skill.origin !== 'scan';

  // Separate pipeline skills from regular skills
  const pipelineSkills = skills.filter(s => PIPELINE_SLUGS.includes(s.slug));
  const regularSkills = skills.filter(s => !PIPELINE_SLUGS.includes(s.slug));

  const filteredSkills = searchQuery.trim()
    ? regularSkills.filter(s =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : regularSkills;

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
        if (expandedId === id) setExpandedId(null);
        if (editingId === id) setEditingId(null);
      }
    } catch {
      // Silent failure
    } finally {
      setDeleting(null);
    }
  }

  function startEditing(skill: Skill) {
    setEditingId(skill.id);
    setEditForm({
      name: skill.name,
      description: skill.description || '',
      content: skill.content,
      source: skill.source || '',
    });
    setExpandedId(skill.id);
  }

  function cancelEditing() {
    setEditingId(null);
  }

  async function saveEdit(skillId: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name,
          description: editForm.description || null,
          content: editForm.content,
          source: editForm.source || null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setSkills((prev) => prev.map((s) => (s.id === skillId ? data.skill : s)));
        setEditingId(null);
      }
    } catch {
      // Silent failure
    } finally {
      setSaving(false);
    }
  }

  if (skills.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted">
        <p className="text-lg mb-2">No skills registered</p>
        <p className="text-sm mb-3">Register a skill to make reusable agent instructions available to workers.</p>
        <p className="text-sm mb-1">
          Install skills locally with{' '}
          <code className="bg-surface-3 px-1.5 py-0.5 rounded text-xs">buildd skill install</code>
        </p>
        <a
          href="https://docs.buildd.dev/docs/features/skills"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline"
        >
          Learn how to create and install skills &rarr;
        </a>
      </div>
    );
  }

  return (
    <div>
      {/* Workflows section */}
      {pipelineSkills.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Workflows</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {WORKFLOW_CARDS.map(w => {
              const installed = pipelineSkills.some(s => s.slug === `pipeline-${w.type === 'fan-out' ? 'fan-out-merge' : w.type}`);
              return (
                <div
                  key={w.type}
                  className={`border rounded-lg p-3 ${installed ? 'border-primary/30 bg-primary/5' : 'border-border-default'}`}
                >
                  <p className="text-sm font-medium text-text-primary">{w.label}</p>
                  <code className="text-[11px] text-text-muted font-mono mt-1 block">{w.diagram}</code>
                  <p className="text-xs text-text-secondary mt-1.5">{w.description}</p>
                  {installed && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-status-success mt-2">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Installed
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-text-muted mt-2">
            Workflows are available in the task creation form as a &quot;Workflow&quot; selector.
          </p>
        </div>
      )}

      {/* Skills section */}
      {regularSkills.length > 3 && (
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
          />
        </div>
      )}

      <div className="border border-border-default rounded-lg divide-y divide-border-default">
        {filteredSkills.map((skill) => {
          const badge = originBadge[skill.origin] || originBadge.manual;
          const isExpanded = expandedId === skill.id;
          const isEditing = editingId === skill.id;
          const editable = isEditable(skill);

          return (
            <div key={skill.id} className="p-4">
              <div className="flex items-start justify-between">
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : skill.id)}
                >
                  <div className="flex items-center gap-2">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className={`text-text-muted transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                    >
                      <path d="M8 5l7 7-7 7z" />
                    </svg>
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
                    <p className="text-sm text-text-muted mt-0.5 ml-5 line-clamp-1">{skill.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1 ml-5 text-xs text-text-muted flex-wrap">
                    {(skill.recentRuns ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-status-success/10 text-status-success rounded">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                        {skill.recentRuns} run{skill.recentRuns === 1 ? '' : 's'} (30d)
                      </span>
                    )}
                    {(skill.totalRuns ?? 0) > 0 && (skill.recentRuns ?? 0) !== (skill.totalRuns ?? 0) && (
                      <span>{skill.totalRuns} total</span>
                    )}
                    {skill.source && <span>Source: {skill.source}</span>}
                    <span>{new Date(skill.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-4">
                  {/* Edit button — only for server-managed skills */}
                  {editable && (
                    <button
                      onClick={() => isEditing ? cancelEditing() : startEditing(skill)}
                      className={`p-1.5 ${isEditing ? 'text-primary' : 'text-text-muted hover:text-primary'}`}
                      title={isEditing ? 'Cancel edit' : 'Edit'}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  )}

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

              {/* Expanded content / edit form */}
              {isExpanded && (
                <div className="mt-3 ml-5">
                  {isEditing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
                        <input
                          type="text"
                          value={editForm.name}
                          onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="w-full px-3 py-1.5 border border-border-default rounded-md bg-surface-1 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">Description</label>
                        <input
                          type="text"
                          value={editForm.description}
                          onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))}
                          className="w-full px-3 py-1.5 border border-border-default rounded-md bg-surface-1 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">Content (SKILL.md)</label>
                        <textarea
                          value={editForm.content}
                          onChange={(e) => setEditForm(f => ({ ...f, content: e.target.value }))}
                          rows={12}
                          className="w-full px-3 py-1.5 border border-border-default rounded-md bg-surface-1 text-sm font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">Source</label>
                        <input
                          type="text"
                          value={editForm.source}
                          onChange={(e) => setEditForm(f => ({ ...f, source: e.target.value }))}
                          className="w-full px-3 py-1.5 border border-border-default rounded-md bg-surface-1 text-sm"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEdit(skill.id)}
                          disabled={saving}
                          className="px-3 py-1.5 bg-primary text-white text-sm rounded-md hover:bg-primary-hover disabled:opacity-50"
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={cancelEditing}
                          className="px-3 py-1.5 border border-border-default text-sm rounded-md hover:bg-surface-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      {!editable && (
                        <p className="text-xs text-text-muted mb-2 italic">
                          Read-only — this skill was discovered from the filesystem
                        </p>
                      )}
                      <pre className="text-sm bg-surface-2 border border-border-default rounded-md p-3 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                        {skill.content}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {searchQuery && filteredSkills.length === 0 && (
        <p className="text-center py-6 text-text-muted text-sm">No skills match &quot;{searchQuery}&quot;</p>
      )}
    </div>
  );
}
