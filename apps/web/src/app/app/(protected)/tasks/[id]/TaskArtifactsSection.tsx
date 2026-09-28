'use client';

import { useEffect, useMemo, useState } from 'react';
import ArtifactCard from '@/components/ArtifactCard';
import ArtifactViewer from '@/components/ArtifactViewer';
import type { ArtifactViewerItem } from '@/components/ArtifactViewer';
import type { VisualReviewModel } from '@buildd/shared';
import VisualReviewTray from '@/components/visual-review/VisualReviewTray';
import { parseQaMeta } from '@/lib/mission-visual-review';
import { buildVisualReviewModel } from '@/lib/visual-review-model';
import AuditRoundTrays from './AuditRoundTrays';
import type { TaskArtifactItem } from './task-artifact-items';

type ArtifactItem = TaskArtifactItem;

interface Props {
  artifacts: ArtifactItem[];
  taskId: string;
  baseUrl: string;
  /** If set, open the viewer to this artifact on mount (from ?artifact= param). */
  initialOpenArtifactId?: string | null;
  /** The task's mission. */
  missionId?: string | null;
  /**
   * For a visual-audit task: the mission's review model and this audit's
   * round (`loadVisualReview`). Its screens show as one Tray per round,
   * latest first, decidable in place.
   */
  visual?: { round: number; model: VisualReviewModel } | null;
}

export default function TaskArtifactsSection({
  artifacts,
  taskId,
  baseUrl,
  initialOpenArtifactId,
  missionId,
  visual = null,
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

  // Audit screenshots (a valid metadata.qa) show as Trays; everything else
  // keeps its card. With no mission model (a task outside a mission), the
  // shots still group into one read-only Tray, newest run per screen.
  const shotIds = useMemo(
    () => new Set(items.filter(a => a.type === 'screenshot' && parseQaMeta(a.metadata)).map(a => a.id)),
    [items],
  );
  const localModel = useMemo(() => (visual || shotIds.size === 0 ? null : buildVisualReviewModel({
    missionId: missionId ?? '',
    shots: items.filter(a => shotIds.has(a.id)),
    tasks: [],
    now: Date.now(),
  })), [visual, shotIds, items, missionId]);

  if (artifacts.length === 0 && !visual) return null;

  const viewerItems: ArtifactViewerItem[] = items.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    content: a.content,
    storageKey: a.storageKey,
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
    <div data-testid="task-artifacts" className="mb-8">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        {artifacts.length > 0 ? `Artifacts (${artifacts.length})` : 'Visual audit'}
      </div>
      {visual ? (
        <div data-testid="task-visual-shots" className="mb-4">
          <AuditRoundTrays visual={visual} />
        </div>
      ) : localModel && localModel.cells.length > 0 ? (
        <div data-testid="task-visual-shots" className="mb-4">
          <VisualReviewTray model={localModel} hideLine />
        </div>
      ) : null}
      <div className="space-y-3">
        {items.map((art, index) => shotIds.has(art.id) ? null : (
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
