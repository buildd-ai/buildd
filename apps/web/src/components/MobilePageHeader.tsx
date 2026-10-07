'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TeamSwitcher } from './TeamSwitcher';
import { useTheme } from './ThemeProvider';
import UserAvatarMenu from './UserAvatarMenu';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { mobileBackHref, mobilePageTitle, showsWorkspaceFilter } from '@/lib/nav-config';
import MobileTopBar, { MOBILE_TOP_BAR_CONTROL_CLASS, MOBILE_TOP_BAR_SLOT_ID } from './MobileTopBar';
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
  const { resolved, setTheme } = useTheme();
  const phoneHome = pathname === '/app/home';
  const chatRoute = pathname === '/app/chat';
  const title = mobilePageTitle(pathname);
  const backHref = mobileBackHref(pathname);
  const currentTeam = teams.find(t => t.id === currentTeamId) ?? teams[0] ?? null;
  const bannersRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bannerHeight = useElementHeight(bannersRef, title !== null);
  // One switcher for the app: in this header on a phone, and in the desktop
  // bar below on the same pages. Both read and write ?workspace=.
  const showSwitcher = workspaces.length > 0 && showsWorkspaceFilter(pathname);
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
  // Desktop: the same switcher, right-aligned in a slim bar above the page.
  const desktopBar = showSwitcher ? (
    <div data-testid="desktop-app-header" className="hidden md:flex items-center justify-end gap-3 border-b border-border-default bg-surface-1 px-8 py-1.5">
      <WorkspaceSwitcher workspaces={workspaces} teamName={currentTeam?.name ?? null} />
    </div>
  ) : null;

  if (!title) return <>{desktopBar}{banners}</>;

  const leading = (
    <>
      {/* Breadcrumb cluster: `Page · Team ⌄`, where the team segment is itself the
          switcher (turbopuffer/Vercel pattern) rather than a separate glyph in the
          right-hand cluster. Anchoring the menu here also keeps it on-screen.
          The page name never truncates; a long team name gives way first
          (TeamSwitcher caps itself at 140px). */}
      {backHref && (
        <Link
          href={backHref}
          aria-label={`Back to ${mobilePageTitle(backHref) ?? 'the previous page'}`}
          className="-ml-2 w-11 h-11 shrink-0 flex items-center justify-center text-text-secondary hover:text-text-primary"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="15,5 8,12 15,19" />
          </svg>
        </Link>
      )}
      {phoneHome && showSwitcher ? <WorkspaceSwitcher showMobileLabel workspaces={workspaces} teamName={currentTeam?.name ?? null} /> : <span className="shrink-0 font-semibold text-text-primary">{phoneHome ? 'buildd' : title}</span>}
      {currentTeam && !phoneHome && (
        <>
          <span className="text-text-muted shrink-0" aria-hidden="true">·</span>
          <TeamSwitcher teams={teams} currentTeamId={currentTeamId} />
        </>
      )}
    </>
  );
  const trailing = (
    <>
      {showSwitcher && !phoneHome && <WorkspaceSwitcher workspaces={workspaces} teamName={currentTeam?.name ?? null} />}
      {phoneHome && <button type="button" onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')} aria-label={resolved === 'dark' ? 'Switch to Day' : 'Switch to Night'} className={MOBILE_TOP_BAR_CONTROL_CLASS}>{resolved === 'dark' ? '☀' : '☾'}</button>}
      <UserAvatarMenu neutral={phoneHome} userInitial={userInitial} direction="down" active={isAccountRoute(pathname)} />
    </>
  );
  // Chat owns its crumbs (title, History) — they portal into the shell's slot.
  const headerRow = chatRoute ? (
    <MobileTopBar barRef={headerRef}><div id={MOBILE_TOP_BAR_SLOT_ID} className="flex min-w-0 flex-1 items-center gap-2" /></MobileTopBar>
  ) : (
    <MobileTopBar barRef={headerRef} leading={leading} trailing={trailing} />
  );


  return (
    <>
      {/* Fixed on mobile, in flow on desktop (the header row is md:hidden there,
          so desktop sees the switcher bar and the banners at the top of the column). */}
      <div data-testid="mobile-top-stack" className="max-md:fixed max-md:top-0 max-md:inset-x-0 max-md:z-10">
        {headerRow}
        {desktopBar}
        {/* Opaque base: the banners use translucent tints, and fixed over
            scrolling content they would let the page show through. */}
        <div ref={bannersRef} className="max-md:bg-surface-1">{banners}</div>
      </div>
      {/* Pages clear the header with their own pt-14 (Chat has none, so its spacer
          also covers the bar); this pushes <main> down by
          the banners' height so a banner never covers page content. */}
      <div
        data-testid="mobile-banner-spacer"
        aria-hidden="true"
        className="md:hidden shrink-0"
        style={{ height: bannerHeight + (chatRoute ? headerHeight : 0) }}
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
