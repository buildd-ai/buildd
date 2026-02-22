'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { uploadImagesToR2 } from '@/lib/upload';

interface PastedImage {
  filename: string;
  mimeType: string;
  data: string;
}

interface Props {
  workspaces: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (taskId: string) => void;
}

const LAST_WORKSPACE_KEY = 'buildd:lastWorkspaceId';

export default function StartTaskModal({
  workspaces,
  onClose,
  onCreated,
}: Props) {
  // Workspace selection
  const getDefaultWorkspace = () => {
    if (workspaces.length === 1) return workspaces[0].id;
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(LAST_WORKSPACE_KEY);
      if (stored && workspaces.some(w => w.id === stored)) return stored;
    }
    return workspaces[0]?.id || '';
  };

  const [workspaceId, setWorkspaceId] = useState(getDefaultWorkspace);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [showDescription, setShowDescription] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [mode, setMode] = useState<'execution' | 'planning'>('execution');
  const [recurring, setRecurring] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !workspaceId) return;

    setLoading(true);
    setError('');

    try {
      // Save last workspace
      localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);

      if (recurring) {
        const res = await fetch(`/api/workspaces/${workspaceId}/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: title.trim(),
            cronExpression,
            timezone: 'UTC',
            taskTemplate: {
              title: title.trim(),
              description: description.trim() || undefined,
              priority: 5,
            },
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create schedule');
        }

        window.location.href = `/app/workspaces/${workspaceId}/schedules`;
        return;
      }

      // Upload images to R2 if available
      let attachments: any[] | undefined;
      if (pastedImages.length > 0) {
        try {
          attachments = await uploadImagesToR2(workspaceId, pastedImages);
        } catch {
          attachments = pastedImages;
        }
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          title: title.trim(),
          description: description.trim() || null,
          priority: 5,
          mode,
          creationSource: 'dashboard',
          ...(attachments && { attachments }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create task');
      }

      const task = await res.json();
      onCreated(task.id);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const selectedWorkspace = workspaces.find(w => w.id === workspaceId);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end md:items-start justify-center md:pt-32 z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-surface-2 rounded-t-2xl md:rounded-lg shadow-xl w-full md:max-w-md md:mx-4 animate-slide-up md:animate-none">
        <form onSubmit={handleSubmit}>
          <div className="p-4 border-b border-border-default">
            <div className="flex items-center justify-between">
              <div className="text-sm text-text-secondary">
                {workspaces.length > 1 ? (
                  <select
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    className="bg-transparent text-text-primary font-medium border-none focus:ring-0 p-0 pr-6 -ml-1 cursor-pointer"
                  >
                    {workspaces.map(ws => (
                      <option key={ws.id} value={ws.id}>{ws.name}</option>
                    ))}
                  </select>
                ) : (
                  <>New task in <span className="font-medium text-text-primary">{selectedWorkspace?.name}</span></>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-text-muted hover:text-text-primary"
              >
                &times;
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {error && (
              <div className="p-2 text-sm bg-status-error/10 text-status-error rounded">
                {error}
              </div>
            )}

            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onPaste={handlePaste}
              placeholder="What needs to be done?"
              className="w-full px-3 py-2 border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary"
              disabled={loading}
            />

            {/* Mode + Recurring toggles */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setMode('execution')}
                className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                  mode === 'execution'
                    ? 'border-primary/30 bg-primary-subtle text-primary'
                    : 'border-border-default text-text-muted hover:text-text-secondary'
                }`}
              >
                Execute
              </button>
              <button
                type="button"
                onClick={() => setMode('planning')}
                className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                  mode === 'planning'
                    ? 'border-primary/30 bg-primary-subtle text-primary'
                    : 'border-border-default text-text-muted hover:text-text-secondary'
                }`}
              >
                Plan first
              </button>
              <button
                type="button"
                onClick={() => setRecurring(!recurring)}
                className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                  recurring
                    ? 'border-primary/30 bg-primary-subtle text-primary'
                    : 'border-border-default text-text-muted hover:text-text-secondary'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recurring
              </button>
              {recurring && (
                <input
                  type="text"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  className="flex-1 px-2 py-1 text-xs font-mono border border-border-default rounded-md bg-surface-1"
                  placeholder="0 9 * * *"
                />
              )}
            </div>

            {showDescription ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                placeholder="Description (optional) — paste images here"
                rows={3}
                className="w-full px-3 py-2 border border-border-default rounded-lg bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary text-sm"
                disabled={loading}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowDescription(true)}
                className="px-3 py-2 text-sm text-text-muted hover:text-text-secondary hover:bg-surface-3 rounded-lg border border-dashed border-border-default w-full text-left"
              >
                + Add description
              </button>
            )}

            {pastedImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pastedImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={img.data}
                      alt={img.filename}
                      className="max-h-20 rounded border border-border-default"
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

          <div className="p-4 border-t border-border-default flex flex-col md:flex-row md:justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="hidden md:block px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-3 rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim() || !workspaceId}
              className="w-full md:w-auto py-3 md:py-1.5 px-3 text-sm bg-status-success hover:bg-status-success/90 text-white rounded hover:opacity-90 disabled:opacity-50 font-medium"
            >
              {loading
                ? 'Starting...'
                : recurring
                  ? 'Create Schedule'
                  : 'Start'
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
