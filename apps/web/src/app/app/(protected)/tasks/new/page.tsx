'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uploadImagesToR2 } from '@/lib/upload';

const LAST_WORKSPACE_KEY = 'buildd:lastWorkspaceId';

interface Workspace {
  id: string;
  name: string;
  isDefault?: boolean;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [requirePlan, setRequirePlan] = useState(false);

  // Skills state
  const [availableSkills, setAvailableSkills] = useState<{ id: string; slug: string; name: string }[]>([]);
  const [selectedSkillSlugs, setSelectedSkillSlugs] = useState<string[]>([]);
  const [useSkillAgents, setUseSkillAgents] = useState(false);

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
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoadingWorkspaces(false));
  }, []);

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
        setAvailableSkills(
          (data.skills || []).map((s: any) => ({ id: s.id, slug: s.slug, name: s.name }))
        );
      })
      .catch(() => setAvailableSkills([]));
    setSelectedSkillSlugs([]);
  }, [selectedWorkspaceId]);

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const workspaceId = formData.get('workspaceId') as string;
    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
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

        // Create one-time task
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            title,
            description,
            priority,
            ...(requirePlan && { mode: 'planning' }),
            ...(attachments && { attachments }),
            ...(parsedOutputSchema && { outputSchema: parsedOutputSchema }),
            ...(selectedSkillSlugs.length > 0 && {
              context: {
                skillSlugs: selectedSkillSlugs,
                ...(useSkillAgents && { useSkillAgents: true }),
              },
            }),
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
              <select
                id="workspaceId"
                name="workspaceId"
                required
                disabled={loadingWorkspaces}
                value={selectedWorkspaceId}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
              >
                <option value="">Select a workspace</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
            </div>

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

            <div>
              <label htmlFor="title" className="block text-sm font-medium mb-2">
                Task Title
              </label>
              <input
                type="text"
                id="title"
                name="title"
                required
                placeholder={recurring ? "Run full test suite" : "Fix login bug"}
                className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium mb-2">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                required={!recurring}
                rows={recurring ? 4 : 6}
                placeholder={recurring
                  ? "Instructions for each run. Agents receive this every time the schedule fires."
                  : "Describe what needs to be done. Be specific about requirements, files to modify, and expected behavior. Paste images here."
                }
                onPaste={handlePaste}
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

            {/* Skills picker */}
            {availableSkills.length > 0 && (
              <div>
                <label className="block text-sm font-medium mb-2">Skills</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {selectedSkillSlugs.map(slug => {
                    const skill = availableSkills.find(s => s.slug === slug);
                    return (
                      <span
                        key={slug}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary/10 text-primary text-sm rounded-full"
                      >
                        {skill?.name || slug}
                        <button
                          type="button"
                          onClick={() => setSelectedSkillSlugs(prev => prev.filter(s => s !== slug))}
                          className="hover:text-primary-hover"
                        >
                          &times;
                        </button>
                      </span>
                    );
                  })}
                </div>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value && !selectedSkillSlugs.includes(e.target.value)) {
                      setSelectedSkillSlugs(prev => [...prev, e.target.value]);
                    }
                    e.target.value = '';
                  }}
                  className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 text-sm"
                >
                  <option value="">+ Add skill...</option>
                  {availableSkills
                    .filter(s => !selectedSkillSlugs.includes(s.slug))
                    .map(s => (
                      <option key={s.id} value={s.slug}>{s.name} ({s.slug})</option>
                    ))
                  }
                </select>
                <p className="text-xs text-text-secondary mt-1">
                  Skills provide reusable instructions to the worker agent.
                </p>
                {selectedSkillSlugs.length > 0 && (
                  <label className="flex items-start gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useSkillAgents}
                      onChange={(e) => setUseSkillAgents(e.target.checked)}
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
                  <select
                    id="timezone"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1"
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">Eastern (America/New_York)</option>
                    <option value="America/Chicago">Central (America/Chicago)</option>
                    <option value="America/Denver">Mountain (America/Denver)</option>
                    <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
                    <option value="Europe/London">London (Europe/London)</option>
                    <option value="Europe/Berlin">Berlin (Europe/Berlin)</option>
                    <option value="Asia/Tokyo">Tokyo (Asia/Tokyo)</option>
                    <option value="Asia/Shanghai">Shanghai (Asia/Shanghai)</option>
                    <option value="Australia/Sydney">Sydney (Australia/Sydney)</option>
                  </select>
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
