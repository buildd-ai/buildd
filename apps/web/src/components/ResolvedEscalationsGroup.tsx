'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import type { ResolvedEscalationItem } from '@/lib/action-queue';

interface Props {
  items: ResolvedEscalationItem[];
}

/**
 * Renders resolved escalation items below the active action queue (I-10).
 *
 * Resolution means prLifecycleStatus = 'merged' | 'closed' — never re-derived
 * from GitHub; always reads persisted DB state.
 *
 * ≥3 items: collapsed disclosure row by default (▶ N resolved escalations).
 * <3 items: expanded by default.
 * Height transition 200ms ease-out.
 */
export function ResolvedEscalationsGroup({ items }: Props) {
  const collapseByDefault = items.length >= 3;
  const [collapsed, setCollapsed] = useState(collapseByDefault);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>(collapseByDefault ? 0 : 'auto');

  useEffect(() => {
    if (!contentRef.current) return;
    if (!collapsed) {
      // Expand: measure and animate to full height
      const fullHeight = contentRef.current.scrollHeight;
      setHeight(fullHeight);
      const timer = setTimeout(() => setHeight('auto'), 200);
      return () => clearTimeout(timer);
    } else {
      // Collapse: snapshot height then animate to 0
      const fullHeight = contentRef.current.scrollHeight;
      setHeight(fullHeight);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setHeight(0));
      });
    }
  }, [collapsed]);

  if (items.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-default pt-3">
      {collapseByDefault && (
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1.5 text-[11px] font-mono text-text-muted hover:text-text-secondary w-full text-left py-1 transition-colors"
          aria-expanded={!collapsed}
        >
          <span className="transition-transform duration-200" style={{ display: 'inline-block', transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
            ▶
          </span>
          <span>{items.length} resolved escalation{items.length !== 1 ? 's' : ''}</span>
        </button>
      )}
      <div
        ref={contentRef}
        style={{
          height: height === 'auto' ? 'auto' : `${height}px`,
          overflow: 'hidden',
          transition: 'height 200ms ease-out',
        }}
      >
        <div className="space-y-1.5 pt-1">
          {items.map((item) => (
            <div
              key={item.workerId}
              className="opacity-50 border-l-2 border-border-default rounded-r-[10px] px-4 py-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-[10px] font-mono text-text-muted tracking-wide uppercase">
                      {item.prLifecycleStatus === 'merged' ? 'Merged' : 'Closed'}
                    </span>
                    {item.workspaceName && (
                      <span className="text-[10px] text-text-muted">{item.workspaceName}</span>
                    )}
                  </div>
                  {item.taskId ? (
                    <Link
                      href={`/app/tasks/${item.taskId}`}
                      className="text-[13px] font-medium text-text-primary truncate hover:underline block"
                    >
                      {item.taskTitle}
                    </Link>
                  ) : (
                    <div className="text-[13px] font-medium text-text-primary truncate">{item.taskTitle}</div>
                  )}
                </div>
                {item.prUrl && item.prNumber != null && (
                  <a
                    href={item.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-text-muted hover:underline flex-shrink-0"
                  >
                    PR #{item.prNumber} ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
