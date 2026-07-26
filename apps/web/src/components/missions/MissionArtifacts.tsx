'use client';

import { useState } from 'react';
import ArtifactViewer, { type ArtifactViewerItem } from '@/components/ArtifactViewer';

interface Props {
  artifacts: ArtifactViewerItem[];
  baseUrl: string;
}

export default function MissionArtifacts({ artifacts, baseUrl }: Props) {
  const [items, setItems] = useState<ArtifactViewerItem[]>(artifacts);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  if (items.length === 0) return null;

  return (
    <div className="mb-6" data-testid="mission-artifacts">
      <h2 className="section-label mb-3">Artifacts ({items.length})</h2>
      <div className="space-y-1.5">
        {items.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              setIndex(i);
              setOpen(true);
            }}
            data-testid="mission-artifact-row"
            className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-card-border hover:border-border-hover transition-colors"
          >
            <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <div className="flex-1 min-w-0">
              <span className="text-[13px] text-text-primary truncate block">
                {a.title || 'Untitled'}
              </span>
              <span className="text-[11px] text-text-muted">
                {a.type} &middot; {a.taskTitle}
              </span>
            </div>
            <span className="text-[11px] text-text-muted shrink-0 flex items-center gap-0.5">
              View
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </span>
          </button>
        ))}
      </div>

      <ArtifactViewer
        artifacts={items}
        open={open}
        initialIndex={index}
        onClose={() => setOpen(false)}
        baseUrl={baseUrl}
        canShare
        onShareChange={(id, next) =>
          setItems((prev) =>
            prev.map((it) =>
              it.id === id
                ? { ...it, visibility: next.visibility, shareToken: next.shareToken }
                : it,
            ),
          )
        }
      />
    </div>
  );
}
