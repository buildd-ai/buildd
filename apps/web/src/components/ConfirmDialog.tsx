'use client';

import { useId, useRef } from 'react';
import Dialog from './ui/Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

type ConfirmVariant = NonNullable<ConfirmDialogProps['variant']>;

/**
 * Which button takes focus on open. Destructive variants start on Cancel so a
 * stray Enter or Space cannot confirm a delete.
 */
export function confirmInitialFocus(variant: ConfirmVariant): 'cancel' | 'confirm' {
  return variant === 'default' ? 'confirm' : 'cancel';
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  if (!open) return null;

  const variantStyles = {
    danger: {
      button: 'border-2 border-status-error text-status-error bg-transparent hover:bg-surface-4',
      icon: (
        <svg className="w-6 h-6 text-status-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    warning: {
      button: 'border-2 border-status-warning text-status-warning bg-transparent hover:bg-surface-4',
      icon: (
        <svg className="w-6 h-6 text-status-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    default: {
      button: 'bg-primary text-white hover:bg-primary-hover',
      icon: (
        <svg className="w-6 h-6 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  };

  const styles = variantStyles[variant];

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={messageId}
      dismissible={!loading}
      initialFocusRef={confirmInitialFocus(variant) === 'cancel' ? cancelButtonRef : confirmButtonRef}
    >
      <div className="p-6 overflow-y-auto max-h-[70vh]">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center">
            {styles.icon}
          </div>
          <div className="flex-1 min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-text-primary">
              {title}
            </h3>
            <p id={messageId} className="mt-2 text-sm text-text-secondary whitespace-pre-wrap">
              {message}
            </p>
          </div>
        </div>
      </div>
      <div className="px-6 py-4 bg-surface-3 rounded-b-lg flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="w-full sm:w-auto px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmButtonRef}
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={`w-full sm:w-auto px-4 py-2 text-sm rounded-lg disabled:opacity-50 ${styles.button}`}
        >
          {loading ? 'Processing…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
