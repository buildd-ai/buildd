'use client';

/**
 * The ask-first step this page puts in front of every destructive action
 * (revoking an app, disconnecting a runner, removing another team's runner):
 * the button's first tap swaps in a sentence saying what will happen, a
 * "Keep it" way back, and the action again. Only the second tap acts.
 */
import type { ReactNode } from 'react';

export default function InlineConfirm({
  question,
  confirmLabel,
  busyLabel,
  busy,
  disabled = false,
  onKeep,
  onConfirm,
  testId,
  confirmTestId,
}: {
  /** What happens, in plain words. */
  question: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  /** This action is in flight: the confirm button shows busyLabel. */
  busy: boolean;
  /** Another action on the page is in flight. */
  disabled?: boolean;
  onKeep: () => void;
  onConfirm: () => void;
  testId?: string;
  confirmTestId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <span className="text-body text-text-primary">{question}</span>
      <button type="button" className="btn btn-sm h-11 md:h-8" onClick={onKeep} disabled={disabled}>Keep it</button>
      <button type="button" data-testid={confirmTestId} className="btn btn-danger btn-sm h-11 md:h-8" onClick={onConfirm} disabled={disabled}>
        {busy ? busyLabel : confirmLabel}
      </button>
    </div>
  );
}
