'use client';

import ErrorState from '@/components/ErrorState';

export default function TaskError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
      <div className="text-text-muted font-mono text-xs uppercase tracking-widest">Task Error</div>
      <ErrorState
        className="max-w-md w-full"
        message="We couldn't load this task. Retry, and if it keeps failing, come back in a minute."
        detail={error.stack || error.message}
        digest={error.digest}
        onRetry={reset}
      />
    </div>
  );
}
