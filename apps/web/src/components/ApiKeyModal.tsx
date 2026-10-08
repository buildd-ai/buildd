'use client';

import { useId, useRef, useState } from 'react';
import Dialog from './ui/Dialog';
import PrimaryAction from './ui/PrimaryAction';

interface ApiKeyModalProps {
  open: boolean;
  accountName: string;
  apiKey: string;
  onClose: () => void;
}

/** Shows a freshly created key once: one value, one copy action, done. */
export default function ApiKeyModal({ open, accountName, apiKey, onClose }: ApiKeyModalProps) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  if (!open) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      labelledBy={titleId}
      describedBy={descId}
      initialFocusRef={copyRef}
      className="bg-surface-2 shadow-xl w-full max-w-[calc(100vw-2rem)] sm:max-w-lg mx-4 flex flex-col max-h-[90vh] outline-none"
    >
      <div className="p-6 space-y-4 overflow-y-auto flex-1">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-text-primary">
            Token created for {accountName}
          </h3>
          <p id={descId} className="mt-1 text-sm text-text-secondary">
            Copy it now. You won&apos;t be able to see it again.
          </p>
        </div>

        <div className="flex items-stretch border-2 border-border-strong bg-surface-4">
          <code
            data-testid="api-key-value"
            className="flex-1 min-w-0 px-3 py-2.5 font-mono text-sm text-text-primary break-all select-all"
          >
            {apiKey}
          </code>
          <button
            ref={copyRef}
            type="button"
            onClick={handleCopy}
            aria-live="polite"
            className="btn shrink-0 h-auto border-0 border-l-2 border-border-strong min-w-[72px]"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="px-6 py-4 bg-surface-3 flex justify-end flex-shrink-0">
        <PrimaryAction onClick={handleClose}>Done</PrimaryAction>
      </div>
    </Dialog>
  );
}
