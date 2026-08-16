'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { InitiativeTriageRow } from './InitiativeTriageRow';
import { partitionInitiativeZones } from '@/lib/verdict-presentation';
import type { InitiativePulse } from '@/lib/verdict-presentation';

/**
 * The Initiatives list, partitioned by verdict (spec §4.3).
 *
 * Zones are ordered by *are we winning*, not by pending-action count, so the page
 * answers the question top-down: Not-winning (in ladder order, so a `losing` arc
 * is always the first row), then Winning, then Dormant behind a disclosure.
 *
 * Dismissal is dormant-only and client-side: `localStorage`, no server mutation,
 * so a reload restores every row (§4.4).
 */

interface InitiativeTriageProps {
  items: InitiativePulse[];
  teamId: string;
}

interface DismissedRow {
  id: string;
  at: number; // epoch ms — kept so entries can be expired later
}

function loadDismissed(teamId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(`triage-dismissed-${teamId}`);
    if (!raw) return new Set();
    const parsed: DismissedRow[] = JSON.parse(raw);
    return new Set(parsed.map((r) => r.id));
  } catch {
    return new Set();
  }
}

function saveDismissed(teamId: string, ids: Set<string>) {
  try {
    const arr: DismissedRow[] = [...ids].map((id) => ({ id, at: Date.now() }));
    localStorage.setItem(`triage-dismissed-${teamId}`, JSON.stringify(arr));
  } catch {
    // Private-mode or quota failure — the row simply stays visible.
  }
}

export function InitiativeTriage({ items, teamId }: InitiativeTriageProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showDormant, setShowDormant] = useState(false);
  const [banners, setBanners] = useState<Set<string>>(new Set());
  const bannerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Read after mount, never during render: the server has no localStorage, and
  // seeding state from it directly would hydrate-mismatch every dismissed row.
  useEffect(() => {
    setDismissed(loadDismissed(teamId));
  }, [teamId]);

  useEffect(() => {
    const timers = bannerTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleDismiss = useCallback(
    (id: string) => {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(teamId, next);
        return next;
      });

      setBanners((prev) => new Set(prev).add(id));

      const timer = setTimeout(() => {
        setBanners((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        bannerTimers.current.delete(id);
      }, 4000);
      bannerTimers.current.set(id, timer);
    },
    [teamId],
  );

  const handleUndo = useCallback(
    (id: string) => {
      const timer = bannerTimers.current.get(id);
      if (timer) clearTimeout(timer);
      bannerTimers.current.delete(id);

      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        saveDismissed(teamId, next);
        return next;
      });
      setBanners((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [teamId],
  );

  const visible = items.filter((i) => !dismissed.has(i.id));
  const { notWinning, winning, dormant } = partitionInitiativeZones(visible);

  // Dismissed dormant rows leave the list but keep a 4-second undo in place.
  const undoable = items.filter((i) => banners.has(i.id));

  const hasDivider = notWinning.length > 0 && winning.length > 0;

  return (
    <div>
      {notWinning.map((item) => (
        <InitiativeTriageRow key={item.id} pulse={item} />
      ))}

      {hasDivider && <hr className="my-1 border-t border-border-subtle" />}

      {winning.map((item) => (
        <InitiativeTriageRow key={item.id} pulse={item} />
      ))}

      {undoable.map((item) => (
        <div key={`undo-${item.id}`} className="px-1 py-2.5">
          <button
            type="button"
            onClick={() => handleUndo(item.id)}
            className="text-[12px] text-text-muted hover:text-text-secondary transition-colors"
          >
            Hid &ldquo;{item.title}&rdquo; — undo
          </button>
        </div>
      ))}

      {dormant.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowDormant((v) => !v)}
            className="text-[11px] text-text-muted hover:text-text-secondary transition-colors py-1"
          >
            {showDormant ? 'Hide dormant' : `Show ${dormant.length} dormant`}
          </button>

          {showDormant && (
            <div className="mt-1 opacity-60">
              {dormant.map((item) => (
                <InitiativeTriageRow key={item.id} pulse={item} onDismiss={handleDismiss} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
