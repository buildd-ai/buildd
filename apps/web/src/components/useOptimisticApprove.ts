'use client';

import { useOptimistic, useState, useTransition } from 'react';

export type ApproveResult = { tone: 'ok' | 'err' | 'warn' | 'info'; text: string; action?: { label: string; href: string } };

/**
 * An Approve action that answers on the press: `shown` reads as approved at
 * once while the request is out, then becomes what the server said. A failure
 * rolls back to the action with the error beside it (`retry`), so the person
 * can press again; a refusal that pressing again cannot fix (a moved spec, a
 * stale link) stays a notice with no action.
 *
 * `pending`: what shows while the request is out, when "approved" would be
 * premature (a team that requires a passkey asks for it after the press).
 * `send` may call `update` to change what shows while it is still out.
 */
export function useOptimisticApprove(
  send: (update: (r: ApproveResult) => void) => Promise<ApproveResult>,
  approvedText: string,
  onApproved?: () => void,
  pending?: ApproveResult,
): { shown: ApproveResult | null; retry: boolean; approve: () => void } {
  const [result, setResult] = useState<ApproveResult | null>(null);
  const [shown, setShown] = useOptimistic(result);
  const [, startTransition] = useTransition();
  function approve() {
    startTransition(async () => {
      setShown(pending ?? { tone: 'ok', text: approvedText });
      let next: ApproveResult;
      try {
        next = await send((r) => startTransition(() => setShown(r)));
      } catch {
        next = { tone: 'err', text: 'Approval failed. Try again.' };
      }
      startTransition(() => {
        setResult(next);
        if (next.tone === 'ok') onApproved?.();
      });
    });
  }
  return { shown, retry: shown?.tone === 'err', approve };
}
