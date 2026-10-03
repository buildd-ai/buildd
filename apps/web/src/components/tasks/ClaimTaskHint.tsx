'use client';

/**
 * How a person takes a local mission's task from their own session:
 * `claim_task {taskId: "…"}`, with a copy button. One component for the
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
  const command = claimTaskCommand(taskId);
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
      <p className="font-mono text-[11.5px] leading-snug text-text-secondary [overflow-wrap:anywhere]">
        {lead} <code className="text-text-primary">{command}</code>
      </p>
      <button
        type="button"
        data-testid="claim-task-copy"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void copy(); }}
        className="inline-flex min-h-11 items-center justify-center self-start border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white hover:bg-primary-hover"
      >
        {copied ? 'Copied' : 'Copy claim command'}
      </button>
    </div>
  );
}
