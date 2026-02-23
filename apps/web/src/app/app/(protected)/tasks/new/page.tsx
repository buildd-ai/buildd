'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { uploadImagesToR2 } from '@/lib/upload';
import { Select } from '@/components/ui/Select';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-options';
import { SkillPills } from '@/components/skills/SkillPills';
import { WorkflowSelector, type WorkflowType } from '@/components/skills/WorkflowSelector';
import { SkillSlashTypeahead } from '@/components/skills/SkillSlashTypeahead';
import type { TaskCategoryValue } from '@buildd/shared';

const LAST_WORKSPACE_KEY = 'buildd:lastWorkspaceId';

const CATEGORY_OPTIONS: { value: TaskCategoryValue; label: string; color: string }[] = [
  { value: 'bug', label: 'Bug', color: 'bg-cat-bug/15 text-cat-bug border-cat-bug/30' },
  { value: 'feature', label: 'Feature', color: 'bg-cat-feature/15 text-cat-feature border-cat-feature/30' },
  { value: 'refactor', label: 'Refactor', color: 'bg-cat-refactor/15 text-cat-refactor border-cat-refactor/30' },
  { value: 'chore', label: 'Chore', color: 'bg-cat-chore/15 text-cat-chore border-cat-chore/30' },
  { value: 'docs', label: 'Docs', color: 'bg-cat-docs/15 text-cat-docs border-cat-docs/30' },
  { value: 'test', label: 'Test', color: 'bg-cat-test/15 text-cat-test border-cat-test/30' },
  { value: 'infra', label: 'Infra', color: 'bg-cat-infra/15 text-cat-infra border-cat-infra/30' },
  { value: 'design', label: 'Design', color: 'bg-cat-design/15 text-cat-design border-cat-design/30' },
];

const WORKFLOW_SKILL_SLUGS = ['pipeline-fan-out-merge', 'pipeline-sequential', 'pipeline-release'];

interface Workspace {
  id: string;
  name: string;
  isDefault?: boolean;
  gitConfig?: {
    targetBranch?: string;
    defaultBranch?: string;
    requiresPR?: boolean;
    autoCreatePR?: boolean;
  } | null;
  configStatus?: 'unconfigured' | 'admin_confirmed';
}

interface PastedImage {
  filename: string;
  mimeType: string;
  data: string; // base64 data URL
}

interface CronPreview {
  valid: boolean;
  description?: string;
  nextRuns?: string[];
}

export default function NewTaskPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [requirePlan, setRequirePlan] = useState(false);
  const [taskTargetBranch, setTaskTargetBranch] = useState('');

  // Title state (controlled for legibility hint)
  const [titleValue, setTitleValue] = useState('');

  // Category state
  const [selectedCategory, setSelectedCategory] = useState<TaskCategoryValue | null>(null);

  // Project state
  const [project, setProject] = useState('');
  const [projectSuggestions, setProjectSuggestions] = useState<{ name: string; color?: string }[]>([]);
  const [showProjectSuggestions, setShowProjectSuggestions] = useState(false);

  // Description state (expandable)
  const [showDescription, setShowDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState('');

  // Workflow state
  const [workflowType, setWorkflowType] = useState<WorkflowType>('single');

  // Skills state
  const [availableSkills, setAvailableSkills] = useState<{ id: string; slug: string; name: string; description?: string | null; recentRuns?: number }[]>([]);
  const [selectedSkillSlugs, setSelectedSkillSlugs] = useState<string[]>([]);
  const [useSkillAgents, setUseSkillAgents] = useState(false);

  // Advanced options toggle
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Dependency state
  const [depSearch, setDepSearch] = useState('');
  const [depResults, setDepResults] = useState<{ id: string; title: string; status: string }[]>([]);
  const [selectedDeps, setSelectedDeps] = useState<{ id: string; title: string }[]>([]);
  const [depLoading, setDepLoading] = useState(false);

  // Structured output state
  const [useOutputSchema, setUseOutputSchema] = useState(false);
  const [outputSchemaText, setOutputSchemaText] = useState('{\n  "type": "object",\n  "properties": {\n    \n  },\n  "required": []\n}');
  const [outputSchemaError, setOutputSchemaError] = useState('');

  // Recurring schedule state
  const [recurring, setRecurring] = useState(false);
  const [scheduleName, setScheduleName] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [cronPreview, setCronPreview] = useState<CronPreview | null>(null);

  // Filter out pipeline skills from the pill picker
  const nonPipelineSkills = availableSkills.filter(s => !WORKFLOW_SKILL_SLUGS.includes(s.slug));

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setPastedImages(prev => [...prev, {
            filename: file.name || `pasted-image-${Date.now()}.png`,
            mimeType: file.type,
            data: dataUrl,
          }]);
        };
        reader.readAsDataURL(file);
        setShowDescription(true);
      }
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPastedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  useEffect(() => {
    fetch('/api/workspaces')
      .then(res => res.json())
      .then(data => {
        const ws = data.workspaces || [];
        setWorkspaces(ws);

        if (ws.length > 0) {
          const wsParam = searchParams.get('workspaceId');
          if (wsParam && ws.some((w: Workspace) => w.id === wsParam)) {
            setSelectedWorkspaceId(wsParam);
          } else {
            const lastUsed = localStorage.getItem(LAST_WORKSPACE_KEY);
            const lastUsedExists = lastUsed && ws.some((w: Workspace) => w.id === lastUsed);

            if (lastUsedExists) {
              setSelectedWorkspaceId(lastUsed);
            } else {
              const defaultWs = ws.find((w: Workspace) => w.isDefault);
              if (defaultWs) {
                setSelectedWorkspaceId(defaultWs.id);
              } else if (ws.length === 1) {
                setSelectedWorkspaceId(ws[0].id);
              }
            }
          }
        }
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoadingWorkspaces(false));
  }, []);

  // Fetch projects when workspace changes
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setProjectSuggestions([]);
      setProject('');
      return;
    }
    fetch(`/api/workspaces/${selectedWorkspaceId}/projects`)
      .then(res => res.json())
      .then(data => setProjectSuggestions(data.projects || []))
      .catch(() => setProjectSuggestions([]));
  }, [selectedWorkspaceId]);

  // Fetch enabled skills when workspace changes
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAvailableSkills([]);
      setSelectedSkillSlugs([]);
      return;
    }
    fetch(`/api/workspaces/${selectedWorkspaceId}/skills?enabled=true`)
      .then(res => res.json())
      .then(data => {
        const loadedSkills = (data.skills || []).map((s: any) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, recentRuns: s.recentRuns || 0 }));
        setAvailableSkills(loadedSkills);
        const skillSlugParam = searchParams.get('skillSlug');
        if (skillSlugParam && loadedSkills.some((s: { slug: string }) => s.slug === skillSlugParam)) {
          setSelectedSkillSlugs([skillSlugParam]);
        }
      })
      .catch(() => setAvailableSkills([]));
    setSelectedSkillSlugs([]);
  }, [selectedWorkspaceId]);

  // Debounced dependency search
  useEffect(() => {
    if (!depSearch.trim() || !selectedWorkspaceId) {
      setDepResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setDepLoading(true);
      try {
        const res = await fetch(`/api/tasks?workspaceId=${selectedWorkspaceId}&q=${encodeURIComponent(depSearch)}&status=pending,blocked,assigned,in_progress,running`);
        const data = await res.json();
        setDepResults((data.tasks || [])
          .filter((t: any) => !selectedDeps.some(d => d.id === t.id))
          .slice(0, 5)
          .map((t: any) => ({ id: t.id, title: t.title, status: t.status }))
        );
      } catch {
        setDepResults([]);
      } finally {
        setDepLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [depSearch, selectedWorkspaceId, selectedDeps]);

  // Validate cron expression with live preview
  useEffect(() => {
    if (!recurring || !selectedWorkspaceId || !cronExpression.trim()) {
      setCronPreview(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${selectedWorkspaceId}/schedules/validate?cron=${encodeURIComponent(cronExpression)}&timezone=${encodeURIComponent(timezone)}`
        );
        if (res.ok) {
          setCronPreview(await res.json());
        }
      } catch {
        // Non-critical
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [recurring, cronExpression, timezone, selectedWorkspaceId]);

  // Map workflow type to pipeline skill slug
  const workflowToSkillSlug: Record<string, string> = {
    'fan-out': 'pipeline-fan-out-merge',
    'sequential': 'pipeline-sequential',
    'release': 'pipeline-release',
  };

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const workspaceId = formData.get('workspaceId') as string;
    const title = titleValue.trim();
    const description = descriptionValue.trim();
    const priority = parseInt(formData.get('priority') as string) || 0;

    try {
      if (recurring) {
        // Create schedule
        const res = await fetch(`/api/workspaces/${workspaceId}/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: scheduleName.trim() || title,
            cronExpression,
            timezone,
            taskTemplate: {
              title,
              description: description || undefined,
              priority,
              ...(selectedSkillSlugs.length > 0 && {
                context: {
                  skillSlugs: selectedSkillSlugs,
                  ...(useSkillAgents && { useSkillAgents: true }),
                },
              }),
            },
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to create schedule');
        }

        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
        router.push(`/app/workspaces/${workspaceId}/schedules`);
        router.refresh();
      } else {
        // Upload images to R2 if available, fall back to inline base64
        let attachments: any[] | undefined;
        if (pastedImages.length > 0) {
          try {
            attachments = await uploadImagesToR2(workspaceId, pastedImages);
          } catch {
            // R2 not configured or upload failed — fall back to inline base64
            attachments = pastedImages;
          }
        }

        // Parse outputSchema if enabled
        let parsedOutputSchema: Record<string, unknown> | undefined;
        if (useOutputSchema && outputSchemaText.trim()) {
          try {
            parsedOutputSchema = JSON.parse(outputSchemaText);
          } catch {
            setError('Invalid JSON in output schema');
            setLoading(false);
            return;
          }
        }

        // Build context — merge skills, workflow, and target branch override
        const taskContext: Record<string, unknown> = {};

        // Combine selected skills + workflow pipeline skill
        const allSkillSlugs = [...selectedSkillSlugs];
        const pipelineSlug = workflowToSkillSlug[workflowType];
        if (pipelineSlug && !allSkillSlugs.includes(pipelineSlug)) {
          allSkillSlugs.push(pipelineSlug);
        }
        if (allSkillSlugs.length > 0) {
          taskContext.skillSlugs = allSkillSlugs;
          if (useSkillAgents) taskContext.useSkillAgents = true;
        }
        if (workflowType !== 'single') {
          taskContext.workflow = workflowType;
        }
        if (taskTargetBranch) {
          taskContext.targetBranch = taskTargetBranch;
        }

        // Create one-time task
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            title,
            description: description || undefined,
            priority,
            ...(selectedCategory && { category: selectedCategory }),
            ...(project.trim() && { project: project.trim() }),
            ...(requirePlan && { mode: 'planning' }),
            ...(attachments && { attachments }),
            ...(parsedOutputSchema && { outputSchema: parsedOutputSchema }),
            ...(selectedDeps.length > 0 && { blockedByTaskIds: selectedDeps.map(d => d.id) }),
            ...(Object.keys(taskContext).length > 0 && { context: taskContext }),
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to create task');
        }

        const created = await res.json();
        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
        router.push(`/app/tasks/${created.id}`);
        router.refresh();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleSkillToggle = (slug: string) => {
    setSelectedSkillSlugs(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  const handleSlashSelectSkill = (slug: string) => {
    if (!selectedSkillSlugs.includes(slug)) {
      setSelectedSkillSlugs(prev => [...prev, slug]);
    }
  };

  return (
    <div className="p-4 pb-8 md:p-8 md:pb-8 overflow-auto h-full">
      <div className="max-w-xl mx-auto md:mx-0">
        <nav aria-label="Breadcrumb" className="text-sm text-text-secondary mb-4">
          <Link href="/app/tasks" className="hover:text-text-primary">Tasks</Link>
          <span className="mx-2">/</span>
          <span className="text-text-primary">New Task</span>
        </nav>
        <h1 className="text-2xl font-bold mb-6">New Task</h1>

        {workspaces.length === 0 && !loadingWorkspaces ? (
          <div className="border border-dashed border-border-default rounded-lg p-8 text-center">
            <p className="text-text-secondary mb-4">You need a workspace first</p>
            <Link
              href="/app/workspaces/new"
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover"
            >
              Create Workspace
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
                {error}
              </div>
            )}

            {/* Run once / Recurring toggle */}
            <div className="flex items-center gap-1 p-1 bg-surface-3 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setRecurring(false)}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  !recurring
                    ? 'bg-surface-1 text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                Run once
              </button>
              <button
                type="button"
                onClick={() => setRecurring(true)}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
                  recurring
                    ? 'bg-surface-1 text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recurring
              </button>
            </div>

            <div>
              <label htmlFor="workspaceId" className="block text-sm font-medium mb-2">
                Workspace
              </label>
              <Select
                id="workspaceId"
                name="workspaceId"
                disabled={loadingWorkspaces}
                value={selectedWorkspaceId}
                onChange={setSelectedWorkspaceId}
                placeholder="Select a workspace"
                options={workspaces.map((ws) => ({
                  value: ws.id,
                  label: ws.name,
                }))}
              />
              {selectedWorkspaceId && (() => {
                const ws = workspaces.find(w => w.id === selectedWorkspaceId);
                if (!ws) return null;
                const defaultTarget = ws.gitConfig?.targetBranch || ws.gitConfig?.defaultBranch;
                const isConfigured = ws.configStatus === 'admin_confirmed';
                const effectiveBranch = taskTargetBranch || defaultTarget;
                return (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {effectiveBranch ? (
                      <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                        PRs target <code className="px-1 py-0.5 bg-surface-3 rounded text-text-primary">{effectiveBranch}</code>
                        {taskTargetBranch && <span className="text-primary">(override)</span>}
                        {!taskTargetBranch && (
                          <Link href={`/app/workspaces/${ws.id}/config`} className="text-primary hover:underline ml-1">change default</Link>
                        )}
                      </span>
                    ) : !isConfigured ? (
                      <span className="inline-flex items-center gap-1 text-xs text-status-warning">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        No PR target branch set — will use repo default
                        <Link href={`/app/workspaces/${ws.id}/config`} className="text-primary hover:underline ml-1">configure</Link>
                      </span>
                    ) : null}
                  </div>
                );
              })()}
            </div>

            {/* Workflow selector (one-time tasks only) */}
            {!recurring && (
              <WorkflowSelector value={workflowType} onChange={setWorkflowType} />
            )}

            {/* Schedule name (recurring only) */}
            {recurring && (
              <div>
                <label htmlFor="scheduleName" className="block text-sm font-medium mb-2">
                  Schedule Name
                </label>
                <input
                  type="text"
                  id="scheduleName"
                  value={scheduleName}
                  onChange={(e) => setScheduleName(e.target.value)}
                  placeholder="e.g. Nightly test suite"
                  className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
                />
                <p className="text-xs text-text-secondary mt-1">Optional. Defaults to task title.</p>
              </div>
            )}

            {/* Title */}
            <div>
              <label htmlFor="title" className="block text-sm font-medium mb-2">
                Task Title
              </label>
              <input
                type="text"
                id="title"
                name="title"
                required
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                placeholder={
                  recurring
                    ? "Run full test suite"
                    : showDescription
                      ? "Brief title"
                      : "What needs to be done? Be specific."
                }
                className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
              />
              {/* Legibility hint when description is collapsed and title is short */}
              {!showDescription && titleValue.length > 0 && titleValue.length < 40 && (
                <p className="text-text-muted text-xs mt-1">
                  Tip: be descriptive — the agent only sees this title
                </p>
              )}
            </div>

            {/* Category selector */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Category <span className="text-text-muted font-normal">(auto-detected if empty)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSelectedCategory(selectedCategory === opt.value ? null : opt.value)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                      selectedCategory === opt.value
                        ? opt.color + ' border-current'
                        : 'bg-surface-3 text-text-secondary border-transparent hover:bg-surface-4'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Project typeahead */}
            <div>
              <label htmlFor="project" className="block text-sm font-medium mb-2">
                Project <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  id="project"
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setShowProjectSuggestions(true);
                  }}
                  onFocus={() => setShowProjectSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowProjectSuggestions(false), 150)}
                  placeholder="e.g. frontend, api, infra"
                  className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
                />
                {showProjectSuggestions && projectSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-surface-2 border border-border-default rounded-md shadow-lg max-h-40 overflow-y-auto">
                    {projectSuggestions
                      .filter(p => !project || p.name.toLowerCase().includes(project.toLowerCase()))
                      .map(p => (
                        <button
                          key={p.name}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setProject(p.name);
                            setShowProjectSuggestions(false);
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-surface-3 flex items-center gap-2"
                        >
                          {p.color && (
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: p.color }}
                            />
                          )}
                          {p.name}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>

            {/* Expandable description */}
            {showDescription ? (
              <div>
                <label htmlFor="description" className="block text-sm font-medium mb-2">
                  Description
                </label>
                <SkillSlashTypeahead
                  id="description"
                  name="description"
                  value={descriptionValue}
                  onChange={setDescriptionValue}
                  onPaste={handlePaste}
                  skills={nonPipelineSkills}
                  selectedSlugs={selectedSkillSlugs}
                  onSelectSkill={handleSlashSelectSkill}
                  placeholder={recurring
                    ? "Instructions for each run. Agents receive this every time the schedule fires."
                    : "Describe what needs to be done. Type / to add skills. Paste images here."
                  }
                  rows={recurring ? 4 : 6}
                  className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
                />
                {pastedImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {pastedImages.map((img, i) => (
                      <div key={i} className="relative group">
                        <img
                          src={img.data}
                          alt={img.filename}
                          className="max-h-24 rounded border border-border-default"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(i)}
                          className="absolute -top-2 -right-2 w-5 h-5 bg-status-error text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowDescription(true)}
                className="text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                + Add details
              </button>
            )}

            {/* Skills pill picker */}
            {nonPipelineSkills.length > 0 && (
              <SkillPills
                skills={nonPipelineSkills}
                selectedSlugs={selectedSkillSlugs}
                onToggle={handleSkillToggle}
                useSkillAgents={useSkillAgents}
                onUseSkillAgentsChange={setUseSkillAgents}
              />
            )}

            {/* ── Advanced Options (Progressive Disclosure) ── */}
            <div className="border-t border-border-default pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Advanced options
                {(requirePlan || useOutputSchema || selectedDeps.length > 0 || taskTargetBranch) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-6">
                  {/* Priority — hidden input always present for form submission */}
                  <div>
                    <label htmlFor="priority" className="block text-sm font-medium mb-2">
                      Priority (0-10)
                    </label>
                    <input
                      type="number"
                      id="priority"
                      name="priority"
                      min="0"
                      max="10"
                      defaultValue="5"
                      className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
                    />
                  </div>

                  {/* Dependencies (one-time tasks only) */}
                  {!recurring && selectedWorkspaceId && (
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        Dependencies <span className="text-text-muted font-normal">(optional)</span>
                      </label>
                      {selectedDeps.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {selectedDeps.map(dep => (
                            <span
                              key={dep.id}
                              className="inline-flex items-center gap-1 px-2.5 py-1 bg-status-info/10 text-status-info text-sm rounded-full"
                            >
                              {dep.title}
                              <button
                                type="button"
                                onClick={() => setSelectedDeps(prev => prev.filter(d => d.id !== dep.id))}
                                className="hover:text-status-info/80"
                              >
                                &times;
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <input
                        type="text"
                        value={depSearch}
                        onChange={(e) => setDepSearch(e.target.value)}
                        placeholder="Search for tasks to depend on..."
                        className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
                      />
                      {depResults.length > 0 && (
                        <div className="mt-1 border border-border-default rounded-md bg-surface-1 max-h-40 overflow-y-auto">
                          {depResults.map(result => (
                            <button
                              key={result.id}
                              type="button"
                              onClick={() => {
                                setSelectedDeps(prev => [...prev, { id: result.id, title: result.title }]);
                                setDepSearch('');
                                setDepResults([]);
                              }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-surface-3 flex items-center justify-between"
                            >
                              <span className="truncate">{result.title}</span>
                              <span className="text-xs text-text-muted ml-2">{result.status}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {depLoading && (
                        <p className="text-xs text-text-muted mt-1">Searching...</p>
                      )}
                      <p className="text-xs text-text-secondary mt-1">
                        Task will start as &quot;blocked&quot; until all dependencies complete.
                      </p>
                    </div>
                  )}

                  {/* Plan mode toggle (one-time tasks only) */}
                  {!recurring && (
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={requirePlan}
                        onChange={(e) => setRequirePlan(e.target.checked)}
                        className="w-[18px] h-[18px] accent-primary cursor-pointer"
                      />
                      <div>
                        <span className="text-sm font-medium">Require plan first</span>
                        <p className="text-xs text-text-secondary mt-0.5">
                          Agent will create an implementation plan for your approval before writing code
                        </p>
                      </div>
                    </label>
                  )}

                  {/* Structured output schema (one-time tasks only) */}
                  {!recurring && (
                    <div>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useOutputSchema}
                          onChange={(e) => setUseOutputSchema(e.target.checked)}
                          className="w-[18px] h-[18px] accent-primary cursor-pointer"
                        />
                        <div>
                          <span className="text-sm font-medium">Require structured output</span>
                          <p className="text-xs text-text-secondary mt-0.5">
                            Agent will return validated JSON matching a schema you define
                          </p>
                        </div>
                      </label>
                      {useOutputSchema && (
                        <div className="mt-3 border border-border-default rounded-lg p-4 bg-surface-2">
                          <label htmlFor="outputSchema" className="block text-sm font-medium mb-2">
                            JSON Schema
                          </label>
                          <textarea
                            id="outputSchema"
                            value={outputSchemaText}
                            onChange={(e) => {
                              setOutputSchemaText(e.target.value);
                              setOutputSchemaError('');
                              try {
                                JSON.parse(e.target.value);
                              } catch {
                                setOutputSchemaError('Invalid JSON');
                              }
                            }}
                            rows={8}
                            spellCheck={false}
                            className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary font-mono text-sm"
                            placeholder='{"type": "object", "properties": {...}, "required": [...]}'
                          />
                          {outputSchemaError && (
                            <p className="text-xs text-status-error mt-1">{outputSchemaError}</p>
                          )}
                          <p className="text-xs text-text-secondary mt-1">
                            Define the shape of the data you want back. Uses{' '}
                            <a href="https://json-schema.org/understanding-json-schema/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              JSON Schema
                            </a>{' '}
                            syntax.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Git branch override */}
                  {selectedWorkspaceId && !recurring && (
                    <div>
                      <label htmlFor="taskTargetBranch" className="block text-sm font-medium mb-2">
                        Git branch override <span className="text-text-muted font-normal">(optional)</span>
                      </label>
                      <input
                        id="taskTargetBranch"
                        type="text"
                        value={taskTargetBranch}
                        onChange={(e) => setTaskTargetBranch(e.target.value.trim())}
                        placeholder="e.g. release/1.0, hotfix, main"
                        className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
                      />
                      <p className="text-xs text-text-secondary mt-1">Override workspace default for this task only. PRs will target this branch.</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Hidden priority input when advanced is collapsed (form needs it) */}
            {!showAdvanced && (
              <input type="hidden" name="priority" value="5" />
            )}

            {/* Cron fields (recurring only) */}
            {recurring && (
              <div className="border border-border-default rounded-lg p-4 space-y-4 bg-surface-2">
                <div>
                  <label htmlFor="cron" className="block text-sm font-medium mb-2">
                    Schedule
                  </label>
                  <input
                    type="text"
                    id="cron"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary font-mono text-sm"
                    placeholder="0 9 * * *"
                    required
                  />
                  {cronPreview && (
                    <div className="mt-2">
                      {cronPreview.valid ? (
                        <div className="text-sm">
                          <p className="text-status-success">{cronPreview.description}</p>
                          {cronPreview.nextRuns && cronPreview.nextRuns.length > 0 && (
                            <div className="text-text-secondary mt-1 space-y-0.5">
                              {cronPreview.nextRuns.map((run, i) => (
                                <p key={i} className="text-xs">{run}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-status-error">{cronPreview.description}</p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-text-secondary mt-1">
                    minute hour day-of-month month day-of-week
                  </p>
                </div>

                <div>
                  <label htmlFor="timezone" className="block text-sm font-medium mb-2">
                    Timezone
                  </label>
                  <Select
                    id="timezone"
                    value={timezone}
                    onChange={setTimezone}
                    options={TIMEZONE_OPTIONS}
                    searchable
                  />
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-2">
              <button
                type="submit"
                disabled={loading || loadingWorkspaces || (recurring && cronPreview !== null && !cronPreview.valid)}
                className="flex-1 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
              >
                {loading
                  ? (recurring ? 'Creating Schedule...' : 'Creating...')
                  : (recurring ? 'Create Schedule' : 'Create Task')
                }
              </button>
              <Link
                href="/app/tasks"
                className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
              >
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
