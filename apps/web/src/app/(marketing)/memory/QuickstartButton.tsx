'use client';

import { useState } from 'react';

type QuickstartState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; key: string; mcpConfig: object }
  | { status: 'error'; message: string };

export function QuickstartButton() {
  const [state, setState] = useState<QuickstartState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/memory/quickstart', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({
          status: 'error',
          message: body.error || `Request failed (${res.status})`,
        });
        return;
      }
      const data = await res.json();
      setState({
        status: 'success',
        key: data.key,
        mcpConfig: data.mcpConfig,
      });
    } catch {
      setState({ status: 'error', message: 'Network error. Please try again.' });
    }
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (state.status === 'idle') {
    return (
      <button
        onClick={handleGenerate}
        className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors text-sm"
      >
        Generate API Key
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 7l5 5m0 0l-5 5m5-5H6"
          />
        </svg>
      </button>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500/50 text-black font-semibold rounded-lg text-sm cursor-wait">
        <svg
          className="w-4 h-4 animate-spin"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Generating...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="mt-4 space-y-2">
        <p className="text-red-400 text-sm">{state.message}</p>
        <button
          onClick={handleGenerate}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors text-sm"
        >
          Try Again
        </button>
      </div>
    );
  }

  // Success
  const configJson = JSON.stringify(state.mcpConfig, null, 2);

  return (
    <div className="mt-4 space-y-3">
      <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
        <p className="text-green-400 text-sm font-medium mb-1">
          API key generated! Copy the config below into your{' '}
          <code className="bg-white/10 px-1.5 py-0.5 rounded text-xs">
            .mcp.json
          </code>
        </p>
        <p className="text-gray-400 text-xs">
          Save this key — it won&apos;t be shown again.
        </p>
      </div>
      <div className="relative">
        <pre className="text-sm text-gray-300 font-mono leading-relaxed bg-[#1a1c24] rounded-lg p-4 border border-white/10 overflow-x-auto">
          <code>{configJson}</code>
        </pre>
        <button
          onClick={() => handleCopy(configJson)}
          className="absolute top-2 right-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-xs text-gray-300 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
