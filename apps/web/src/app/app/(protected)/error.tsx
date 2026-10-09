'use client';

import Link from 'next/link';
import ErrorState from '@/components/ErrorState';

export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="text-center py-12">
        <div className="w-12 h-12 mx-auto mb-4 bg-status-error/10 rounded-full flex items-center justify-center">
          <svg className="w-6 h-6 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">This page failed to render</h2>
        <ErrorState
          message="Something went wrong loading this page. Try again, or head back home."
          detail={`${error.name}${error.name && error.message ? ': ' : ''}${error.message}`}
          digest={error.digest}
          onRetry={reset}
        >
          <Link
            href="/app/home"
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Back to home
          </Link>
        </ErrorState>
      </div>
    </div>
  );
}
