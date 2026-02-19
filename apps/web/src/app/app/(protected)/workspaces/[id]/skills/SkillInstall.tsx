'use client';

import { useEffect, useRef, useState } from 'react';

const PIPELINE_TEMPLATES = [
  {
    slug: 'pipeline-fan-out-merge',
    name: 'Fan-Out & Merge',
    description: 'Break work into parallel tasks and create a merge task that auto-starts when all complete.',
    content: `# Fan-Out & Merge Pipeline

You are a pipeline coordinator. Your job is to break work into parallel tasks and create a merge task.

## Workflow

1. **Analyze** the task description to identify independent units of work
2. **Create child tasks** using \`buildd create_task\` for each unit:
   - Set descriptive titles
   - Include relevant context in description
3. **Create a rollup/merge task** using \`buildd create_task\`:
   - Title: "Merge: [original task summary]"
   - Description: Instruct the merge worker what to combine and how
   - Set \`blockedByTaskIds\` to all child task IDs
   - This task auto-starts when all children complete
4. **Complete yourself** with a summary of the pipeline you created

## Important
- The merge task's worker will receive \`childResults\` in its claim — it can see what each child produced
- If a child fails, the merge task still runs — it should handle partial results gracefully
- Keep child tasks focused and independent — they may run on different workers`,
  },
  {
    slug: 'pipeline-sequential',
    name: 'Sequential Pipeline',
    description: 'Create a chain of dependent tasks where each step waits for the previous.',
    content: `# Sequential Pipeline

You are a pipeline coordinator. Your job is to create a chain of dependent tasks.

## Workflow

1. **Analyze** the task to identify sequential steps (each depends on the previous)
2. **Create tasks in order**, each blocked by the previous:
   - Task 1: no blockers (starts immediately)
   - Task 2: blockedByTaskIds=[task1Id]
   - Task 3: blockedByTaskIds=[task2Id]
   - etc.
3. **Complete yourself** with a summary of the chain

## Notes
- Each task in the chain receives results from previous tasks via childResults
- Use clear titles that indicate the step order`,
  },
  {
    slug: 'pipeline-release',
    name: 'Release Pipeline',
    description: 'Create parallel validation tasks followed by a guarded merge/release step.',
    content: `# Release Pipeline

You are a release coordinator. Create a safe multi-step release pipeline.

## Workflow

1. **Create parallel validation tasks** (tests, lint, type-check, etc.)
2. **Create a merge/release task** blocked by all validators
   - This task should: merge approved PRs, create release notes, tag the release
3. **Complete yourself** with the pipeline summary

## Notes
- Validation tasks should fail fast and report clear errors
- The merge task checks all childResults — if any validator failed, it reports the failure instead of releasing
- Always use blockedByTaskIds to enforce ordering`,
  },
];

interface Props {
  workspaceId: string;
}

export function SkillInstall({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null);
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

  async function handleInstallTemplate(template: typeof PIPELINE_TEMPLATES[number]) {
    setInstallingTemplate(template.slug);
    setMessage('');
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          slug: template.slug,
          content: template.content,
          description: template.description,
          source: 'builtin',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to install');
      setStatus('ok');
      setMessage(`Installed "${template.name}" skill.`);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setInstallingTemplate(null);
    }
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
          {/* Pipeline Templates Section */}
          <div className="mb-4">
            <p className="text-xs font-medium text-text-secondary mb-2">Pipeline Templates</p>
            <div className="space-y-2">
              {PIPELINE_TEMPLATES.map(template => (
                <div key={template.slug} className="flex items-start gap-2 p-2 rounded-md hover:bg-surface-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">{template.name}</p>
                    <p className="text-xs text-text-muted mt-0.5">{template.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleInstallTemplate(template)}
                    disabled={installingTemplate === template.slug}
                    className="shrink-0 px-2.5 py-1 text-xs bg-primary/10 text-primary hover:bg-primary/20 rounded-md disabled:opacity-50"
                  >
                    {installingTemplate === template.slug ? 'Installing...' : 'Install'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border-default pt-3 mb-3">
            <p className="text-xs font-medium text-text-secondary mb-2">Custom Source</p>
          </div>

          {/* Existing custom install form */}
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
                {status === 'loading' ? 'Dispatching…' : 'Install'}
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
