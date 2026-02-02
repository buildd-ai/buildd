'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';

function ErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  const errorMessages: Record<string, string> = {
    Configuration: 'There is a problem with the server configuration.',
    AccessDenied: 'Access denied. Your email is not on the allowed list.',
    Verification: 'The verification link has expired or has already been used.',
    Default: 'An error occurred during authentication.',
  };

  const message = errorMessages[error || 'Default'] || errorMessages.Default;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-3xl font-bold text-red-600">Authentication Error</h1>
          <p className="mt-4 text-gray-600 dark:text-gray-400">{message}</p>
        </div>

        <Link
          href="/auth/signin"
          className="inline-block px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 transition-opacity"
        >
          Try Again
        </Link>
      </div>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <ErrorContent />
    </Suspense>
  );
}
