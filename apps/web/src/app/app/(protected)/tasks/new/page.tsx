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

        // Create one-time task
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            title,
            description,
            priority,
            ...(attachments && { attachments }),
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
    <div className="p-4 md:p-8 overflow-auto h-full">
      <div className="max-w-xl mx-auto md:mx-0">
        <h1 className="text-2xl font-bold mb-6">New Task</h1>

        {workspaces.length === 0 && !loadingWorkspaces ? (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
            <p className="text-gray-500 mb-4">You need a workspace first</p>
            <Link
              href="/app/workspaces/new"
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              Create Workspace
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
                {error}
              </div>
            )}

            {/* Run once / Recurring toggle */}
            <div className="flex items-center gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setRecurring(false)}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  !recurring
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Run once
              </button>
              <button
                type="button"
                onClick={() => setRecurring(true)}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 ${
                  recurring
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">Optional. Defaults to task title.</p>
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
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {pastedImages.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {pastedImages.map((img, i) => (
                    <div key={i} className="relative group">
                      <img
                        src={img.data}
                        alt={img.filename}
                        className="max-h-24 rounded border border-gray-200 dark:border-gray-700"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Cron fields (recurring only) */}
            {recurring && (
              <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-4 bg-gray-50 dark:bg-gray-900/50">
                <div>
                  <label htmlFor="cron" className="block text-sm font-medium mb-2">
                    Schedule
                  </label>
                  <input
                    type="text"
                    id="cron"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                    placeholder="0 9 * * *"
                    required
                  />
                  {cronPreview && (
                    <div className="mt-2">
                      {cronPreview.valid ? (
                        <div className="text-sm">
                          <p className="text-green-600 dark:text-green-400">{cronPreview.description}</p>
                          {cronPreview.nextRuns && cronPreview.nextRuns.length > 0 && (
                            <div className="text-gray-500 mt-1 space-y-0.5">
                              {cronPreview.nextRuns.map((run, i) => (
                                <p key={i} className="text-xs">{run}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-red-600 dark:text-red-400">{cronPreview.description}</p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
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
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
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

            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading || loadingWorkspaces || (recurring && cronPreview !== null && !cronPreview.valid)}
                className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50"
              >
                {loading
                  ? (recurring ? 'Creating Schedule...' : 'Creating...')
                  : (recurring ? 'Create Schedule' : 'Create Task')
                }
              </button>
              <Link
                href="/app/tasks"
                className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
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
