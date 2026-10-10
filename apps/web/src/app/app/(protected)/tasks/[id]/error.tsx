'use client';

import ErrorState from '@/components/ErrorState';

export default function TaskError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
      <h1 className="text-title font-semibold text-text-primary">This task couldn’t load</h1>
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
