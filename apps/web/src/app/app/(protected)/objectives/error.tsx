'use client';

import Link from 'next/link';

export default function ObjectivesError({
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
        <h2 className="text-lg font-semibold text-text-primary mb-2">Failed to load objectives</h2>
        <p className="text-sm text-text-secondary mb-4">
          Something went wrong while loading the objectives page.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary-hover"
          >
            Try again
          </button>
          <Link
            href="/app/dashboard"
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
