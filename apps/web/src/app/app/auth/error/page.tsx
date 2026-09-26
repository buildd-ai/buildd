'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';

function ErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  const errorMessages: Record<string, string> = {
    Configuration: 'Sign-in is misconfigured on the server.',
    AccessDenied: 'Access denied. Your email is not on the allowed list.',
    Verification: 'This sign-in link expired or was already used.',
    Default: 'Sign-in failed.',
  };

  const message = errorMessages[error || 'Default'] || errorMessages.Default;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-3xl font-bold text-status-error">Authentication Error</h1>
          <p className="mt-4 text-text-secondary">{message}</p>
        </div>

        <Link
          href="/app/auth/signin"
          className="inline-block px-6 py-3 bg-primary text-white rounded-md hover:bg-primary-hover transition-opacity"
        >
          Try again
        </Link>
      </div>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading…</div>}>
      <ErrorContent />
    </Suspense>
  );
}
