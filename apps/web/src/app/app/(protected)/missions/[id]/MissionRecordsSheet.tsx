'use client';

/**
 * `Records · N` — the mission's review-worthy artifacts, in a sheet
 * (docs/design/mission-feed-mobile-continuity.md, W3 footer rows, AC-16,
 * addendum D5). The count and the list are the same `selectMissionRecords`
 * output; everything else is behind "All artifacts" at the bottom of the same
 * sheet. It replaces the unfiltered artifact dump that used to close the page.
 *
 * `?artifact=Z` (mobile-artifact-feed.md §2.2) opens the sheet with Z's viewer.
 *
 * Bodies are lazy (slice S7, AC-18): the page renders artifact metadata only,
 * and the sheet fetches the bodies of the list it is showing when it opens.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchRecordsContent } from '@/lib/mission-records-content';
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
  /** Test seam: the body fetch. Defaults to `/api/missions/[id]/artifacts/content`. */
  loadContent?: (missionId: string, ids: string[]) => Promise<Record<string, string | null>>;
}

/** Ids in `shown` whose body has not been fetched yet. */
export function idsNeedingContent(
  shown: readonly { id: string; content: string | null }[],
  fetched: Readonly<Record<string, string | null>>,
): string[] {
  return shown.filter(a => a.content == null && !(a.id in fetched)).map(a => a.id);
}

/** `items` with fetched bodies filled in. */
export function withContent<T extends { id: string; content: string | null }>(
  items: readonly T[],
  fetched: Readonly<Record<string, string | null>>,
): T[] {
  return items.map(a => (a.content == null && fetched[a.id] != null ? { ...a, content: fetched[a.id] } : a));
}

export default function MissionRecordsSheet({
  missionId,
  baseUrl,
  records,
  allArtifacts,
  initialArtifactId,
  defaultOpen = false,
  loadContent = fetchRecordsContent,
}: MissionRecordsSheetProps) {
  const initial = resolveInitialRecordsView(initialArtifactId, records, allArtifacts);
  const [open, setOpen] = useState(defaultOpen || initial.open);
  const [showAll, setShowAll] = useState(initial.showAll);
  const [fetched, setFetched] = useState<Record<string, string | null>>({});
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);

  const shown = showAll ? allArtifacts : records;
  const missing = open ? idsNeedingContent(shown, fetched) : [];
  const missingKey = missing.join(',');

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    const ids = missingKey.split(',');
    setLoadState('loading');
    loadContent(missionId, ids).then(
      contents => {
        if (cancelled) return;
        // Ids the server did not return are recorded as null so they are not re-asked.
        setFetched(prev => ({ ...prev, ...Object.fromEntries(ids.map(id => [id, contents[id] ?? null])) }));
        setLoadState('idle');
      },
      () => { if (!cancelled) setLoadState('error'); },
    );
    return () => { cancelled = true; };
  }, [missionId, missingKey, loadContent, attempt]);

  const recordsWithContent = useMemo(() => withContent(records, fetched), [records, fetched]);
  const allWithContent = useMemo(() => withContent(allArtifacts, fetched), [allArtifacts, fetched]);

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
        {loadState === 'loading' && (
          <p data-testid="mission-records-loading" className="mb-2 font-mono text-[11px] text-text-muted">Loading record content…</p>
        )}
        {loadState === 'error' && (
          <button
            type="button"
            data-testid="mission-records-retry"
            onClick={() => setAttempt(n => n + 1)}
            className="mb-2 flex min-h-11 items-center font-mono text-[11px] text-status-error"
          >
            Couldn’t load record content · Retry
          </button>
        )}
        {records.length > 0 ? (
          <MissionArtifacts
            artifacts={recordsWithContent}
            baseUrl={baseUrl}
            missionId={missionId}
            initialOpenArtifactId={initial.open && !initial.showAll ? initialArtifactId : null}
          />
        ) : (
          <p className="mb-4 font-mono text-[12px] text-text-muted">No review-worthy records yet.</p>
        )}
        {showAll ? (
          <MissionArtifacts
            artifacts={allWithContent}
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
