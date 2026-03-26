'use client';

export default function TaskError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
      <div className="text-text-muted font-mono text-xs uppercase tracking-widest">Task Error</div>
      <p className="text-text-secondary text-sm max-w-md text-center">
        {error.message || 'Failed to load task details.'}
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm font-medium rounded-lg bg-surface-3 hover:bg-surface-2 border border-border-default text-text-primary transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
