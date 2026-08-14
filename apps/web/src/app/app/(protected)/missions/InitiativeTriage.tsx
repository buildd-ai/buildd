'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { InitiativeTriageRow } from './InitiativeTriageRow';
import type { InitiativeTriageItem } from './triage-types';

interface InitiativeTriageProps {
  items: InitiativeTriageItem[];
  teamId: string;
}

interface DismissedRow {
  id: string;
  at: number; // epoch ms — used to expire old entries
}

function loadDismissed(teamId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(`triage-dismissed-${teamId}`);
    if (!raw) return new Set();
    const parsed: DismissedRow[] = JSON.parse(raw);
    return new Set(parsed.map(r => r.id));
  } catch {
    return new Set();
  }
}

function saveDismissed(teamId: string, ids: Set<string>) {
  try {
    const arr: DismissedRow[] = [...ids].map(id => ({ id, at: Date.now() }));
    localStorage.setItem(`triage-dismissed-${teamId}`, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

function isDormant(item: InitiativeTriageItem): boolean {
  const hasPending = item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
  const hasActivity = item.effortDays.some(d => d.tokens > 0);
  return !hasPending && !hasActivity;
}

function isNeedsYou(item: InitiativeTriageItem): boolean {
  return item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
}

function totalTokens(item: InitiativeTriageItem): number {
  return item.effortDays.reduce((s, d) => s + d.tokens, 0);
}

export function InitiativeTriage({ items, teamId }: InitiativeTriageProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showDormant, setShowDormant] = useState(false);

  // Confirmation banners: { id → timeout handle }
  const [banners, setBanners] = useState<Map<string, string>>(new Map()); // id → href
  const bannerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setDismissed(loadDismissed(teamId));
  }, [teamId]);

  const handleDismiss = useCallback(
    (id: string) => {
      setDismissed(prev => {
        const next = new Set(prev);
        next.add(id);
        saveDismissed(teamId, next);
        return next;
      });

      const href =
        id === '__unassigned__'
          ? '/app/missions?unassigned=true'
          : `/app/initiatives/${id}`;

      setBanners(prev => new Map(prev).set(id, href));

      // Clear after 4s
      const timer = setTimeout(() => {
        setBanners(prev => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        bannerTimers.current.delete(id);
      }, 4000);
      bannerTimers.current.set(id, timer);
    },
    [teamId],
  );

  const handleBannerUndo = useCallback(
    (id: string) => {
      // Clear timer
      const timer = bannerTimers.current.get(id);
      if (timer) clearTimeout(timer);
      bannerTimers.current.delete(id);

      // Restore row
      setDismissed(prev => {
        const next = new Set(prev);
        next.delete(id);
        saveDismissed(teamId, next);
        return next;
      });
      setBanners(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    },
    [teamId],
  );

  // Partition into zones
  const zone1: InitiativeTriageItem[] = [];
  const zone2: InitiativeTriageItem[] = [];
  const zone3: InitiativeTriageItem[] = [];

  for (const item of items) {
    if (dismissed.has(item.id)) continue;
    if (isNeedsYou(item)) {
      zone1.push(item);
    } else if (!isDormant(item)) {
      zone2.push(item);
    } else {
      zone3.push(item);
    }
  }

  // Sort Zone 1: descending action count, then descending progress
  zone1.sort((a, b) => {
    const aCount = a.awaitingVerification + a.blocked + a.held;
    const bCount = b.awaitingVerification + b.blocked + b.held;
    if (bCount !== aCount) return bCount - aCount;
    return b.progress - a.progress;
  });

  // Sort Zone 2: descending shippedThisWeek, then descending total tokens
  zone2.sort((a, b) => {
    if (b.shippedThisWeek !== a.shippedThisWeek) return b.shippedThisWeek - a.shippedThisWeek;
    return totalTokens(b) - totalTokens(a);
  });

  const hasDivider = zone1.length > 0 && zone2.length > 0;
  const dormantCount = zone3.length;

  if (zone1.length === 0 && zone2.length === 0 && dormantCount === 0) return null;

  function renderRow(item: InitiativeTriageItem, dormant: boolean) {
    const banner = banners.get(item.id);
    if (banner !== undefined) {
      return (
        <div key={item.id} className="px-1 py-2.5">
          <Link
            href={banner}
            className="text-[12px] text-text-muted hover:text-text-secondary transition-colors"
            onClick={() => handleBannerUndo(item.id)}
          >
            Moved to Initiatives — tap to find it
          </Link>
        </div>
      );
    }
    return (
      <InitiativeTriageRow
        key={item.id}
        id={item.id}
        title={item.title}
        progress={item.progress}
        effortDays={item.effortDays}
        awaitingVerification={item.awaitingVerification}
        blocked={item.blocked}
        held={item.held}
        shippedThisWeek={item.shippedThisWeek}
        isDormant={dormant}
        onDismiss={dormant ? handleDismiss : undefined}
      />
    );
  }

  return (
    <div>
      {zone1.map(item => renderRow(item, false))}

      {hasDivider && (
        <hr className="my-1 border-t border-border-subtle" />
      )}

      {zone2.map(item => renderRow(item, false))}

      {dormantCount > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowDormant(v => !v)}
            className="text-[11px] text-text-muted hover:text-text-secondary transition-colors py-1"
          >
            {showDormant ? 'Hide dormant' : `Show ${dormantCount} dormant`}
          </button>

          {showDormant && (
            <div className="mt-1 opacity-60">
              {zone3.map(item => renderRow(item, true))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
