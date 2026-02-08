'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function DeviceContent() {
  const searchParams = useSearchParams();
  const prefillCode = searchParams.get('code') || '';

  const [code, setCode] = useState(prefillCode);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Auto-submit if code was pre-filled from URL
  const [autoSubmitted, setAutoSubmitted] = useState(false);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();

    const trimmed = code.trim();
    if (!trimmed) return;

    setStatus('submitting');
    setErrorMessage('');

    try {
      const res = await fetch('/api/auth/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });

      if (res.ok) {
        setStatus('success');
      } else {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        setErrorMessage(data.error || 'Failed to approve device');
        setStatus('error');
      }
    } catch {
      setErrorMessage('Network error. Please try again.');
      setStatus('error');
    }
  }

  // Auto-submit on mount if pre-filled (only once)
  if (prefillCode && !autoSubmitted && status === 'idle') {
    setAutoSubmitted(true);
    // Defer to next tick so React finishes rendering
    setTimeout(() => handleSubmit(), 0);
  }

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
        <div className="absolute inset-0 bg-gradient-to-b from-[#2a2d3a]/60 via-[#2a2d3a]/80 to-[#2a2d3a]/95" />
      </div>

      {/* Card */}
      <div className="relative z-10 w-full max-w-md">
        <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">buildd</h1>
            <p className="text-gray-300">Authorize Device</p>
          </div>

          {status === 'success' ? (
            <div className="text-center">
              <div className="mb-4 bg-green-500/20 border border-green-500/30 rounded-lg p-4 text-green-200">
                Device authorized! You can close this tab and return to your terminal.
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <p className="text-gray-300 text-sm mb-4">
                Enter the code shown in your terminal to link this device.
              </p>

              {status === 'error' && errorMessage && (
                <div className="mb-4 bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-red-200 text-sm">
                  {errorMessage}
                </div>
              )}

              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                autoFocus
                maxLength={9}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white text-center text-2xl font-mono tracking-widest placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />

              <button
                type="submit"
                disabled={status === 'submitting' || !code.trim()}
                className="mt-4 w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'submitting' ? 'Authorizing...' : 'Authorize'}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-gray-400">
            Only approve codes you initiated from your own terminal.
          </p>
        </div>
      </div>
    </main>
  );
}

export default function DevicePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#2a2d3a] text-white">
          Loading...
        </div>
      }
    >
      <DeviceContent />
    </Suspense>
  );
}
