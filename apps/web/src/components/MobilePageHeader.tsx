'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { usePathname } from 'next/navigation';
import { TeamSwitcher } from './TeamSwitcher';
import UserAvatarMenu from './UserAvatarMenu';
import { WorkspaceFilter } from './WorkspaceFilter';
import { mobilePageTitle, showsWorkspaceFilter } from '@/lib/nav-config';
import { isAccountRoute } from '@/lib/nav-active';

interface HeaderTeam {
  id: string;
  name: string;
  slug: string;
}

export default function MobilePageHeader({
  teams = [],
  currentTeamId = null,
  userInitial = 'U',
  workspaces = [],
  banners,
}: {
  teams?: HeaderTeam[];
  currentTeamId?: string | null;
  userInitial?: string;
  workspaces?: { id: string; name: string }[];
  /**
   * Shell-wide banners (needs-input, connector reconnect). On mobile top-level
   * pages they ride in the same fixed stack as the header — rendered in flow they
   * sat under the fixed header, invisible.
   */
  banners?: ReactNode;
}) {
  const pathname = usePathname();
  const title = mobilePageTitle(pathname);
  const currentTeam = teams.find(t => t.id === currentTeamId) ?? teams[0] ?? null;
  const bannersRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bannerHeight = useElementHeight(bannersRef, title !== null);
  const headerHeight = useElementHeight(headerRef, title !== null);

  // Sticky bands inside <main> offset themselves by `--mobile-header-h` (e.g.
  // GroupSection's `top-[var(--mobile-header-h,53px)]`). Banners don't count:
  // the spacer already pushes <main> below them. 0 on desktop (header hidden)
  // and on detail pages (no header).
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--mobile-header-h', `${headerHeight}px`);
  }, [headerHeight]);

  // Only render the header on top-level pages (where the title resolves). Detail
  // pages (e.g. /app/missions/[id]) render their own headers; banners stay in flow.
  if (!title) return <>{banners}</>;

  const headerRow = (
    <div ref={headerRef} data-testid="mobile-page-header" className="md:hidden flex items-center justify-between gap-2 px-4 py-1 bg-surface-2 border-b border-border-default">
      {/* Breadcrumb cluster: `Page · Team ⌄`, where the team segment is itself the
          switcher (turbopuffer/Vercel pattern) rather than a separate glyph in the
          right-hand cluster. Anchoring the menu here also keeps it on-screen. */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] font-normal">
        {/* The page name never truncates: it is the shortest string in the
            cluster and the one that says where you are. A long team name is the
            segment that gives way (TeamSwitcher caps itself at 140px), which is
            why this is `shrink-0` — as a flex sibling it used to surrender
            characters first and render `Initiativ…`. */}
        <span className="shrink-0 font-semibold text-text-primary">{title}</span>
        {currentTeam && (
          <>
            <span className="text-text-muted shrink-0" aria-hidden="true">·</span>
            <TeamSwitcher teams={teams} currentTeamId={currentTeamId} />
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {workspaces.length > 0 && showsWorkspaceFilter(pathname) && <WorkspaceFilter workspaces={workspaces} />}
        <UserAvatarMenu userInitial={userInitial} direction="down" active={isAccountRoute(pathname)} />
      </div>
    </div>
  );

  return (
    <>
      {/* Fixed on mobile, in flow on desktop (the header row is md:hidden there,
          so desktop sees just the banners at the top of the column). */}
      <div data-testid="mobile-top-stack" className="max-md:fixed max-md:top-0 max-md:inset-x-0 max-md:z-10">
        {headerRow}
        {/* Opaque base: the banners use translucent tints, and fixed over
            scrolling content they would let the page show through. */}
        <div ref={bannersRef} className="max-md:bg-surface-1">{banners}</div>
      </div>
      {/* Pages clear the header with their own pt-14; this pushes <main> down by
          the banners' height so a banner never covers page content. */}
      <div
        data-testid="mobile-banner-spacer"
        aria-hidden="true"
        className="md:hidden shrink-0"
        style={{ height: bannerHeight }}
      />
    </>
  );
}

/** Live offsetHeight of `ref` (0 until measured, or while `enabled` is false). */
function useElementHeight(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [height, setHeight] = useState(0);
  // Layout effect: measured before paint, so the spacer and --mobile-header-h
  // never show a frame at 0.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return height;
}
