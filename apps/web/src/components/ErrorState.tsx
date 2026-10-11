'use client';

import type { ReactNode } from 'react';

interface ErrorStateProps {
  /** One sentence: what happened, then what to do. */
  message: string;
  /** Raw error text. Only rendered outside production, and only inside Details. */
  detail?: string | null;
  /** Server-side digest: opaque, safe to show everywhere, and what makes a failure traceable. */
  digest?: string;
  onRetry?: () => void;
  children?: ReactNode;
  className?: string;
}

export default function ErrorState({ message, detail, digest, onRetry, children, className }: ErrorStateProps) {
  const rawText = process.env.NODE_ENV !== 'production' ? detail : null;
  return (
    <div className={className} data-testid="error-state">
      <p className="text-body text-text-secondary">{message}</p>
      {(rawText || digest) && (
        <details className="mt-2 text-left">
          <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary font-mono">Details</summary>
          <pre className="mt-2 text-[11px] font-mono text-text-muted bg-surface-3 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {digest && `digest: ${digest}`}{digest && rawText ? '\n' : ''}{rawText}
          </pre>
        </details>
      )}
      {(onRetry || children) && (
        <div className="mt-3 flex items-center justify-center gap-3">
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-surface-3 hover:bg-surface-2 border border-border-default text-text-primary transition-colors"
            >
              Retry
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
