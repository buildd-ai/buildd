'use client';

import { useState, useEffect } from 'react';
import PrioritySelector from './PrioritySelector';

const PRIORITY_LABEL: Record<number, string> = { 0: 'Low', 5: 'Medium', 10: 'High' };

function priorityLabel(value: number): string {
  return PRIORITY_LABEL[value] ?? (value >= 8 ? 'High' : value >= 3 ? 'Medium' : 'Low');
}

export default function PriorityInlineEdit({
  missionId,
  initialPriority,
}: {
  missionId: string;
  initialPriority: number;
}) {
  const [editing, setEditing] = useState(false);

  // Auto-close after server re-renders with new priority (router.refresh())
  useEffect(() => {
    setEditing(false);
  }, [initialPriority]);

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted">Priority:</span>
        <PrioritySelector missionId={missionId} initialPriority={initialPriority} />
        <button
          onClick={() => setEditing(false)}
          className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
          aria-label="Close priority editor"
        >
          ✕
        </button>
      </div>
    );
  }

  const label = priorityLabel(initialPriority);
  const colorClass =
    initialPriority === 10
      ? 'text-status-error'
      : initialPriority === 5
        ? 'text-status-warning'
        : 'text-text-muted';

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex items-center gap-1 text-[11px] hover:opacity-75 transition-opacity group"
      title="Click to change priority"
    >
      <span className="text-text-muted">Priority:</span>
      <span className={`font-medium ${colorClass}`}>{label}</span>
      <svg
        className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </button>
  );
}
