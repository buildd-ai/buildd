'use client';

import { useState } from 'react';
import MarkdownContent from '@/components/MarkdownContent';

// Long task descriptions push the worker/action UI below the fold on mobile.
// Collapse to ~3 lines by default with a "Show more" toggle. Short
// descriptions render in full with no toggle.
const PREVIEW_CHARS = 220;

export default function CollapsibleDescription({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > PREVIEW_CHARS;

  if (!isLong) {
    return (
      <div className="card p-4">
        <MarkdownContent content={content} />
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div
        className={expanded ? '' : 'line-clamp-3 overflow-hidden'}
        style={expanded ? undefined : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 }}
      >
        <MarkdownContent content={content} />
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted hover:text-text-primary cursor-pointer"
      >
        {expanded ? 'Show less ↑' : 'Show more ↓'}
      </button>
    </div>
  );
}
