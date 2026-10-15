'use client';

/**
 * How a person takes a local mission's task from their own session:
 * `claim_task {taskId: "…"}`, with a copy button. It prints the short id and
 * copies the full one; the button is secondary, never the situation's primary. One component for the
 * strand call ("Keep local") and the task actions of a local mission's task.
 */
import { useState } from 'react';
import { claimTaskCommand } from '@/lib/task-actions';

export default function ClaimTaskHint({
  taskId,
  lead = 'From your session:',
  testId = 'claim-task-hint',
  className = '',
}: {
  taskId: string;
  lead?: string;
  testId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // The full id is what the session needs, so Copy takes it; the card prints
  // the short id people recognise from branch names (spec f7f67f1a R-39).
  const command = claimTaskCommand(taskId);
  const shown = taskId.length > 8 ? claimTaskCommand(`${taskId.slice(0, 8)}…`) : command;
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (insecure origin): the command stays on screen to select.
    }
  }
  return (
    <div data-testid={testId} className={`flex flex-col gap-2 ${className}`}>
      <p className="font-mono text-meta leading-snug text-text-secondary [overflow-wrap:anywhere]">
        {lead} <code className="text-text-primary" title={command}>{shown}</code>
      </p>
      <button
        type="button"
        data-testid="claim-task-copy"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void copy(); }}
        className="btn min-h-11 self-start md:min-h-9"
      >
        {copied ? 'Copied' : 'Copy claim command'}
      </button>
    </div>
  );
}
