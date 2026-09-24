'use client';

/**
 * `Records · N` — the mission's review-worthy artifacts, in a sheet
 * (docs/design/mission-feed-mobile-continuity.md, W3 footer rows, AC-16,
 * addendum D5). The count and the list are the same `selectMissionRecords`
 * output; everything else is behind "All artifacts" at the bottom of the same
 * sheet. It replaces the unfiltered artifact dump that used to close the page.
 *
 * `?artifact=Z` (mobile-artifact-feed.md §2.2) opens the sheet with Z's viewer.
 */
import { useState } from 'react';
import BottomSheet from '@/components/BottomSheet';
import MissionArtifacts from '@/components/missions/MissionArtifacts';
import type { ArtifactViewerItem } from '@/components/ArtifactViewer';

export function resolveInitialRecordsView(
  artifactId: string | null | undefined,
  records: readonly { id: string }[],
  all: readonly { id: string }[],
): { open: boolean; showAll: boolean } {
  if (!artifactId) return { open: false, showAll: false };
  if (records.some(r => r.id === artifactId)) return { open: true, showAll: false };
  if (all.some(a => a.id === artifactId)) return { open: true, showAll: true };
  return { open: false, showAll: false };
}

export const mainScroller = () => (typeof document === 'undefined' ? null : document.querySelector('main'));

export interface MissionRecordsSheetProps {
  missionId: string;
  baseUrl: string;
  /** `selectMissionRecords(allArtifacts)`. */
  records: ArtifactViewerItem[];
  allArtifacts: ArtifactViewerItem[];
  /** `?artifact=` on arrival. */
  initialArtifactId?: string | null;
  /** Test seam: render with the sheet open. */
  defaultOpen?: boolean;
}

export default function MissionRecordsSheet({
  missionId,
  baseUrl,
  records,
  allArtifacts,
  initialArtifactId,
  defaultOpen = false,
}: MissionRecordsSheetProps) {
  const initial = resolveInitialRecordsView(initialArtifactId, records, allArtifacts);
  const [open, setOpen] = useState(defaultOpen || initial.open);
  const [showAll, setShowAll] = useState(initial.showAll);

  if (allArtifacts.length === 0) return null;

  return (
    <>
      <button
        type="button"
        data-testid="mission-records-row"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2 border-t border-border-default text-left font-mono text-[12px] text-text-secondary hover:text-text-primary"
      >
        <span aria-hidden="true" className="text-text-muted">─</span>
        <span className="flex-1">{`Records · ${records.length}`}</span>
        <span aria-hidden="true">›</span>
      </button>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Records"
        height="tall"
        lockTarget={mainScroller}
        testId="mission-records-sheet"
      >
        {records.length > 0 ? (
          <MissionArtifacts
            artifacts={records}
            baseUrl={baseUrl}
            missionId={missionId}
            initialOpenArtifactId={initial.open && !initial.showAll ? initialArtifactId : null}
          />
        ) : (
          <p className="mb-4 font-mono text-[12px] text-text-muted">No review-worthy records yet.</p>
        )}
        {showAll ? (
          <MissionArtifacts
            artifacts={allArtifacts}
            baseUrl={baseUrl}
            missionId={missionId}
            initialOpenArtifactId={initial.showAll ? initialArtifactId : null}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex min-h-11 w-full items-center border-t border-border-default font-mono text-[12px] text-text-secondary hover:text-text-primary"
          >
            {`All artifacts · ${allArtifacts.length} ›`}
          </button>
        )}
      </BottomSheet>
    </>
  );
}
