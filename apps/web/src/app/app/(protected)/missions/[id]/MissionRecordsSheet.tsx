'use client';

/**
 * `Records · N` — the mission's review-worthy artifacts, in a sheet
 * (knowledge-base: buildd/design/mission-feed-mobile-continuity.md, W3 footer rows, AC-16,
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
import { MISSION_RECORDS_OPEN_EVENT, type MissionRecordsOpenRequest } from '@/lib/mission-records-open';
import SideSheet from '@/components/SideSheet';
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
  /**
   * A completed mission's outcome choice (Mission checks I-28 rule 1): the
   * current primary outcome and the artifacts that may be one. Absent: no choice.
   */
  outcome?: { primaryId: string | null; eligibleIds: readonly string[] } | null;
  /** Test seam: the choice's POST. */
  chooseOutcome?: (missionId: string, artifactId: string | null) => Promise<boolean>;
}

async function postOutcomeChoice(missionId: string, artifactId: string | null): Promise<boolean> {
  const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/outcome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifactId }),
  }).catch(() => null);
  return !!res?.ok;
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
  outcome = null,
  chooseOutcome = postOutcomeChoice,
}: MissionRecordsSheetProps) {
  const initial = resolveInitialRecordsView(initialArtifactId, records, allArtifacts);
  const [open, setOpen] = useState(defaultOpen || initial.open);
  const [showAll, setShowAll] = useState(initial.showAll);
  // An in-place open from the outcome hero: which artifact, which one left out,
  // and a counter that remounts the list so its viewer opens on that artifact.
  const [asked, setAsked] = useState<{ artifactId: string | null; exclude: string | null; n: number }>({ artifactId: null, exclude: null, n: 0 });

  useEffect(() => {
    const onOpen = (e: Event) => {
      const req = (e as CustomEvent<MissionRecordsOpenRequest>).detail;
      if (!req || req.missionId !== missionId) return;
      const inRecords = !req.artifactId || records.some(r => r.id === req.artifactId);
      setShowAll(!inRecords);
      setAsked(prev => ({ artifactId: req.artifactId ?? null, exclude: req.exclude ?? null, n: prev.n + 1 }));
      setOpen(true);
    };
    window.addEventListener(MISSION_RECORDS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(MISSION_RECORDS_OPEN_EVENT, onOpen);
  }, [missionId, records]);

  const choice = useMemo(() => (outcome
    ? { primaryId: outcome.primaryId, eligibleIds: new Set(outcome.eligibleIds), choose: (artifactId: string | null) => chooseOutcome(missionId, artifactId) }
    : undefined), [outcome, chooseOutcome, missionId]);
  const [fetched, setFetched] = useState<Record<string, string | null>>({});
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);

  const listed = useMemo(() => (asked.exclude ? records.filter(r => r.id !== asked.exclude) : records), [records, asked.exclude]);
  const shown = showAll ? allArtifacts : listed;
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

  const recordsWithContent = useMemo(() => withContent(listed, fetched), [listed, fetched]);
  const allWithContent = useMemo(() => withContent(allArtifacts, fetched), [allArtifacts, fetched]);

  if (allArtifacts.length === 0) return null;

  return (
    <>
      <button
        type="button"
        data-testid="mission-records-row"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center justify-between gap-x-3 border-t border-border-default text-left text-body hover:text-text-primary"
      >
        <span className="font-semibold text-text-primary">Records</span>
        <span className="text-text-muted">{`${records.length} ›`}</span>
      </button>
      <SideSheet
        open={open}
        onClose={() => { setOpen(false); setAsked(prev => ({ artifactId: null, exclude: null, n: prev.n })); }}
        title={asked.exclude ? 'Supporting reports' : 'Records'}
        testId="mission-records-sheet"
      >
        {/* Mounted while the sheet is open so screen readers hear the change. */}
        <div role="status" aria-live="polite" data-testid="mission-records-status">
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
        </div>
        {listed.length > 0 ? (
          <MissionArtifacts
            key={`records-${asked.n}`}
            artifacts={recordsWithContent}
            baseUrl={baseUrl}
            missionId={missionId}
            initialOpenArtifactId={asked.n > 0 ? (showAll ? null : asked.artifactId) : initial.open && !initial.showAll ? initialArtifactId : null}
            outcomeChoice={choice}
          />
        ) : (
          <p className="mb-4 font-mono text-[12px] text-text-muted">No records to review.</p>
        )}
        {showAll ? (
          <MissionArtifacts
            key={`all-${asked.n}`}
            artifacts={allWithContent}
            baseUrl={baseUrl}
            missionId={missionId}
            initialOpenArtifactId={asked.n > 0 ? asked.artifactId : initial.showAll ? initialArtifactId : null}
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
      </SideSheet>
    </>
  );
}
