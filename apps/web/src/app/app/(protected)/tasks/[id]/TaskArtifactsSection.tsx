'use client';

import { useEffect, useState } from 'react';
import ArtifactCard from '@/components/ArtifactCard';
import ArtifactViewer from '@/components/ArtifactViewer';
import type { ArtifactViewerItem } from '@/components/ArtifactViewer';

interface ArtifactItem {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  shareToken: string | null;
  visibility: 'private' | 'public';
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface Props {
  artifacts: ArtifactItem[];
  taskId: string;
  baseUrl: string;
  /** If set, open the viewer to this artifact on mount (from ?artifact= param). */
  initialOpenArtifactId?: string | null;
}

export default function TaskArtifactsSection({
  artifacts,
  taskId,
  baseUrl,
  initialOpenArtifactId,
}: Props) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [items, setItems] = useState<ArtifactItem[]>(artifacts);

  // Open viewer on mount when ?artifact= param is present
  useEffect(() => {
    if (!initialOpenArtifactId) return;
    const idx = artifacts.findIndex((a) => a.id === initialOpenArtifactId);
    if (idx >= 0) {
      setViewerIndex(idx);
      setViewerOpen(true);
    }
  // Only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (artifacts.length === 0) return null;

  const viewerItems: ArtifactViewerItem[] = items.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    content: a.content,
    shareToken: a.shareToken,
    visibility: a.visibility,
    metadata: a.metadata,
    createdAt: a.createdAt,
  }));

  function openViewer(index: number) {
    setViewerIndex(index);
    setViewerOpen(true);
  }

  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Artifacts ({artifacts.length})
      </div>
      <div className="space-y-3">
        {items.map((art, index) => (
          <ArtifactCard
            key={art.id}
            artifact={art}
            onOpen={() => openViewer(index)}
          />
        ))}
      </div>

      <ArtifactViewer
        artifacts={viewerItems}
        open={viewerOpen}
        initialIndex={viewerIndex}
        onClose={() => setViewerOpen(false)}
        baseUrl={baseUrl}
        canShare
        fromContext={{ type: 'task', taskId }}
        onShareChange={(id, next) => {
          setItems((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, visibility: next.visibility, shareToken: next.shareToken } : a
            )
          );
        }}
      />
    </div>
  );
}
