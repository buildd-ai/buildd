'use client';

import { useState } from 'react';

interface ApiKeyModalProps {
  open: boolean;
  accountName: string;
  apiKey: string;
  onClose: () => void;
}

export default function ApiKeyModal({ open, accountName, apiKey, onClose }: ApiKeyModalProps) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  if (!open) return null;

  const envFormat = `BUILDD_API_KEY=${apiKey}`;

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setAcknowledged(false);
    setCopied(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-2 rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="p-6 space-y-5">
          {/* Header */}
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              API Key for {accountName}
            </h3>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-3 p-3 rounded-lg bg-status-warning/10 border border-status-warning/30">
            <svg className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm text-status-warning font-medium">
              This key will not be shown again. Copy it now and store it securely.
            </p>
          </div>

          {/* API Key display */}
          <div>
            <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">API Key</div>
            <div className="relative group bg-surface-4 rounded-lg p-4">
              <code className="text-base font-mono text-text-primary break-all leading-relaxed" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {apiKey}
              </code>
              <button
                onClick={() => handleCopy(apiKey)}
                className="absolute top-2 right-2 px-2.5 py-1.5 rounded bg-surface-3 hover:bg-surface-2 text-text-secondary hover:text-text-primary text-xs transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Env var format */}
          <div>
            <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Environment Variable</div>
            <div className="relative group bg-surface-4 rounded-lg p-4">
              <code className="text-sm font-mono text-text-primary break-all" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {envFormat}
              </code>
              <button
                onClick={() => handleCopy(envFormat)}
                className="absolute top-2 right-2 px-2.5 py-1.5 rounded bg-surface-3 hover:bg-surface-2 text-text-secondary hover:text-text-primary text-xs transition-colors"
              >
                Copy
              </button>
            </div>
          </div>

          {/* Acknowledgment checkbox */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-border-default accent-primary"
            />
            <span className="text-sm text-text-secondary">
              I have saved this key securely
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-surface-3 rounded-b-lg flex justify-end">
          <button
            onClick={handleClose}
            disabled={!acknowledged}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
