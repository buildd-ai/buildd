'use client';

import { useState } from 'react';
import CopyBlock from '@/components/CopyBlock';

export default function ConnectRunnerSection() {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <section>
      <h2 className="section-label mb-4">Connect Runner</h2>

      <div className="card p-5 space-y-4">
        <div>
          <p className="text-sm text-text-secondary mb-1">
            Run this on your machine to connect your local runner to buildd:
          </p>
        </div>

        {/* Install + login commands */}
        <div className="space-y-3">
          <div>
            <div className="text-xs text-text-muted mb-1.5">Install buildd</div>
            <CopyBlock text="curl -fsSL https://buildd.dev/install.sh | bash" />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1.5">Log in (opens browser for OAuth)</div>
            <CopyBlock text="buildd login" />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1.5">Start claiming tasks</div>
            <CopyBlock text="buildd" />
          </div>
        </div>

        {/* What this does */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform duration-150 ${showDetails ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          How does this work?
        </button>

        {showDetails && (
          <div className="text-xs text-text-muted space-y-2 pl-4 border-l-2 border-border-default">
            <p>
              <code className="bg-surface-4 px-1 rounded">buildd login</code> opens your browser to authenticate with your buildd account via OAuth.
              It stores a session token locally — no API keys to manage.
            </p>
            <p>
              Once logged in, <code className="bg-surface-4 px-1 rounded">buildd</code> runs a worker loop that claims tasks assigned to your workspaces,
              executes them with Claude Code on your machine, and reports results back.
            </p>
            <p>
              Your local Claude Code session (Pro/Max subscription) handles the AI — buildd just coordinates what to work on.
              No API keys or tokens are shared with buildd.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
