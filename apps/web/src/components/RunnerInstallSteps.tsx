'use client';

import { useState } from 'react';
import { RUNNER_HEADLESS_LOGIN, RUNNER_INSTALL_COMMANDS, RUNNER_SERVICE_INSTALL } from '@/lib/runner-install';

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
        No browser on this machine? Use <code className="text-text-secondary">{RUNNER_HEADLESS_LOGIN}</code>. To keep it running in the background, use <code className="text-text-secondary">{RUNNER_SERVICE_INSTALL}</code> instead of <code className="text-text-secondary">buildd</code>.
      </p>
    </div>
  );
}
