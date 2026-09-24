'use client';

import { useState, type ReactNode } from 'react';
import ConfirmDialog from './ConfirmDialog';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
}

/**
 * The promise bookkeeping behind useConfirm, free of React so it can be tested
 * directly. A second request supersedes an unanswered first one, which
 * resolves false (as if cancelled).
 */
export function createConfirmController(setOptions: (options: ConfirmOptions | null) => void) {
  let pending: ((ok: boolean) => void) | null = null;
  return {
    open(next: ConfirmOptions): Promise<boolean> {
      pending?.(false);
      setOptions(next);
      return new Promise<boolean>((resolve) => {
        pending = resolve;
      });
    },
    settle(ok: boolean): void {
      const resolve = pending;
      pending = null;
      setOptions(null);
      resolve?.(ok);
    },
  };
}

/**
 * Promise-returning replacement for `window.confirm()`, backed by ConfirmDialog.
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   if (!(await confirm({ title: 'Delete schedule?', message: '…', variant: 'danger' }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [{ open: confirm, settle }] = useState(() => createConfirmController(setOptions));

  const confirmDialog = (
    <ConfirmDialog
      open={options !== null}
      title={options?.title ?? ''}
      message={options?.message ?? ''}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      variant={options?.variant ?? 'default'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}
