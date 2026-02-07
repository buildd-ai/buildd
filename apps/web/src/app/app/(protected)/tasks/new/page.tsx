'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

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

export default function NewTaskPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);

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

        // Smart workspace selection priority:
        // 1. Last used workspace (from localStorage)
        // 2. Default workspace (if marked)
        // 3. First workspace (if only one)
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const workspaceId = formData.get('workspaceId') as string;
    const data = {
      workspaceId,
      title: formData.get('title') as string,
      description: formData.get('description') as string,
      priority: parseInt(formData.get('priority') as string) || 0,
      ...(pastedImages.length > 0 && { attachments: pastedImages }),
    };

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create task');
      }

      // Remember last used workspace
      localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);

      router.push('/app/tasks');
      router.refresh();
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

            <div>
              <label htmlFor="title" className="block text-sm font-medium mb-2">
                Task Title
              </label>
              <input
                type="text"
                id="title"
                name="title"
                required
                placeholder="Fix login bug"
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
                required
                rows={6}
                placeholder="Describe what needs to be done. Be specific about requirements, files to modify, and expected behavior. Paste images here."
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

            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading || loadingWorkspaces}
                className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Task'}
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
