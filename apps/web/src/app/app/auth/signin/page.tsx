'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function SignInContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const error = searchParams.get('error');

  return (
    <main className="relative min-h-screen flex items-center justify-center p-6 overflow-hidden bg-[#2a2d3a]">
      {/* Hero Background */}
      <div className="absolute inset-0 z-0">
        <picture>
          <source
            media="(min-width: 1024px)"
            srcSet="/hero/logo-desktop.webp"
            type="image/webp"
          />
          <source
            media="(min-width: 768px)"
            srcSet="/hero/logo-tablet.webp"
            type="image/webp"
          />
          <source srcSet="/hero/logo-mobile.webp" type="image/webp" />
          <img
            src="/hero/logo-desktop.png"
            alt=""
            className="w-full h-full object-cover scale-110 blur-sm opacity-40"
          />
        </picture>
        {/* Dark overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#2a2d3a]/60 via-[#2a2d3a]/80 to-[#2a2d3a]/95" />
      </div>

      {/* Glassmorphic Card */}
      <div className="relative z-10 w-full max-w-md">
        <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">buildd</h1>
            <p className="text-gray-300">
              AI Dev Team Orchestration
            </p>
          </div>

          {error && (
            <div className="mb-6 bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-red-200">
              {error === 'AccessDenied'
                ? 'Access denied. Your email is not on the allowed list.'
                : 'An error occurred during sign in.'}
            </div>
          )}

          <div className="space-y-4">
            <button
              onClick={() => signIn('google', { callbackUrl })}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 font-medium rounded-lg hover:bg-gray-100 transition-colors shadow-lg"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </button>

            {process.env.NODE_ENV === 'development' && (
              <button
                onClick={() => signIn('dev-auto-login', { callbackUrl })}
                className="w-full px-4 py-3 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm border border-white/10"
              >
                Dev Auto Login
              </button>
            )}
          </div>

          <p className="mt-6 text-center text-sm text-gray-400">
            Free for personal use
          </p>
        </div>
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <SignInContent />
    </Suspense>
  );
}
