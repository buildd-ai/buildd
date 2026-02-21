'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  workspaceId: string;
}

export function SkillInstall({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function toggle() {
    setOpen(o => !o);
    setStatus('idle');
    setMessage('');
  }

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = source.trim();
    if (!trimmed) return;
    setStatus('loading');
    setMessage('');
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installerCommand: `buildd skill install ${trimmed}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to dispatch');
      setStatus('ok');
      setMessage('Dispatched — connected workers will install and register the skill.');
      setSource('');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="px-4 py-2 border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-lg text-sm"
      >
        Install Skill
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-10 bg-surface-1 border border-border-default rounded-lg shadow-lg p-4 w-96">
          <p className="text-xs text-text-muted mb-3">
            Runs{' '}
            <code className="bg-surface-3 px-1 rounded">buildd skill install</code>{' '}
            on all connected workers. Supports GitHub repos, local paths, and registry slugs.
          </p>
          <form onSubmit={handleInstall} className="flex flex-col gap-2">
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="github:owner/repo or slug"
              autoFocus
              className="px-3 py-2 border border-border-default rounded-md bg-surface-1 text-sm focus:ring-2 focus:ring-primary-ring focus:border-primary"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={status === 'loading' || !source.trim()}
                className="flex-1 px-3 py-2 bg-primary text-white hover:bg-primary-hover rounded-md text-sm disabled:opacity-50"
              >
                {status === 'loading' ? 'Dispatching\u2026' : 'Install'}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-2 border border-border-default text-text-secondary hover:bg-surface-3 rounded-md text-sm"
              >
                Cancel
              </button>
            </div>
            {status === 'ok' && (
              <p className="text-xs text-status-success">{message}</p>
            )}
            {status === 'error' && (
              <p className="text-xs text-status-error">{message}</p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
