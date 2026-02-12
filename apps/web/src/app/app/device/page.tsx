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
    <main className="relative min-h-screen flex items-center justify-center p-6 overflow-hidden bg-surface-1">
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
        <div className="absolute inset-0 bg-surface-1/90" />
      </div>

      {/* Card */}
      <div className="relative z-10 w-full max-w-md">
        <div className="backdrop-blur-xl bg-surface-2/80 border border-border-default rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-text-primary mb-2">buildd</h1>
            <p className="text-text-secondary">Authorize Device</p>
          </div>

          {status === 'success' ? (
            <div className="text-center">
              <div className="mb-4 bg-status-success/10 border border-status-success/20 rounded-lg p-4 text-status-success">
                Device authorized! You can close this tab and return to your terminal.
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <p className="text-text-secondary text-sm mb-4">
                Enter the code shown in your terminal to link this device.
              </p>

              {status === 'error' && errorMessage && (
                <div className="mb-4 bg-status-error/10 border border-status-error/20 rounded-lg p-4 text-status-error text-sm">
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
                className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-lg text-text-primary text-center text-2xl font-mono tracking-widest placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-ring focus:border-primary"
              />

              <button
                type="submit"
                disabled={status === 'submitting' || !code.trim()}
                className="mt-4 w-full px-4 py-3 bg-primary text-white font-medium rounded-md hover:bg-primary-hover transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'submitting' ? 'Authorizing...' : 'Authorize'}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-text-muted">
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
        <div className="flex min-h-screen items-center justify-center bg-surface-1 text-text-primary">
          Loading...
        </div>
      }
    >
      <DeviceContent />
    </Suspense>
  );
}
