'use client';

import { useState } from 'react';

interface Props {
  onSubmit: (text: string) => void;
  sending: boolean;
}

/**
 * Free-text fallback for answering a worker's needs-input question — the only
 * way to answer an open-ended question (one with no options list), and an
 * always-available alternative when options are offered too.
 */
export default function NeedsInputAnswerBox({ onSubmit, sending }: Props) {
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeText, setFreeText] = useState('');

  return (
    <div data-testid="worker-needs-input-freetext">
      {!showFreeText ? (
        <button
          type="button"
          onClick={() => setShowFreeText(true)}
          disabled={sending}
          className="w-full text-left px-4 py-3 text-sm bg-surface-2 text-text-muted rounded-md border border-border-default border-dashed hover:bg-surface-3 hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
        >
          Type your own response ↓
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Your response…"
            rows={3}
            className="px-3 py-2 text-base md:text-sm bg-surface-2 text-text-primary rounded-md border border-border-default focus:border-text-muted focus:outline-none resize-y"
          />
          <button
            type="button"
            onClick={() => {
              if (!freeText.trim()) return;
              onSubmit(freeText);
            }}
            disabled={sending || !freeText.trim()}
            className="px-4 py-2 text-sm bg-text-primary text-surface-1 rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
          >
            {sending ? 'Sending…' : 'Send response'}
          </button>
        </div>
      )}
    </div>
  );
}
