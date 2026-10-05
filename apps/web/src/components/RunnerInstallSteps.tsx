'use client';

import { useState } from 'react';
import { RUNNER_INSTALL_COMMANDS, RUNNER_LOCAL_UI_URL } from '@/lib/runner-install';

/**
 * How to start a runner, in the one wording every screen uses
 * (lib/runner-install.ts). One row per command with a `$` prompt, so a long
 * line that wraps on a phone still reads as one command.
 */
export default function RunnerInstallSteps({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(RUNNER_INSTALL_COMMANDS.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={`text-left ${className}`} data-testid="runner-install-steps">
      <div className="bg-surface-4 p-3">
        <ol className="space-y-1.5 font-mono text-xs text-text-primary">
          {RUNNER_INSTALL_COMMANDS.map((cmd) => (
            <li key={cmd} className="flex gap-2 min-w-0">
              <span aria-hidden="true" className="select-none text-text-muted">$</span>
              <code className="min-w-0 break-words">{cmd}</code>
            </li>
          ))}
        </ol>
        <button type="button" onClick={copy} className="btn btn-sm mt-3 min-h-11 md:min-h-0">
          {copied ? 'Copied' : 'Copy commands'}
        </button>
      </div>
      <p className="text-meta text-text-muted mt-2">
        Then open <code className="text-text-secondary">{RUNNER_LOCAL_UI_URL}</code> to connect your account.
      </p>
    </div>
  );
}
