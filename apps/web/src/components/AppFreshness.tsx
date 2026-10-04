'use client';

/**
 * The protected shell's freshness backstop (lib/app-freshness.ts) and its
 * pull-to-refresh (lib/pull-to-refresh.ts). Mounted once in the layout.
 *
 * - Foreground transitions (visibilitychange, page lifecycle `resume`,
 *   `pageshow`, `focus`), `online`, a Pusher reconnect and a back/forward
 *   navigation all feed one coordinator; each catch-up it emits notifies the
 *   client-fetched surfaces and then `router.refresh()`es the server ones. A
 *   refresh re-renders in place: client state (open sheets, drafts, scroll)
 *   survives, unlike a reload.
 * - On a phone, pulling down from the top of `<main data-scroll-root>` asks for
 *   the same catch-up immediately and shows progress until the new render lands.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getPusherClient } from '@/lib/pusher-client';
import { createReconnectDetector } from '@/lib/realtime-throttle';
import {
  createFreshnessCoordinator,
  emitCatchUp,
  setActiveCoordinator,
  type FreshnessCoordinator,
} from '@/lib/app-freshness';
import { createPullTracker, PULL_THRESHOLD_PX } from '@/lib/pull-to-refresh';
import { findScrollRoot } from '@/lib/scroll-root';
import Spinner from './Spinner';

/** "Up to date" lingers this long after a pull's render lands. */
const DONE_MS = 900;

type PullUi =
  | { phase: 'idle' }
  | { phase: 'pulling'; distance: number; armed: boolean }
  | { phase: 'refreshing' }
  | { phase: 'done' };

/** No scroller between the touch and the root is scrolled down. */
function atTop(root: HTMLElement, target: EventTarget | null): boolean {
  if (root.scrollTop > 0) return false;
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollTop > 0) return false;
    if (el instanceof HTMLElement && el.dataset.pullRefresh === 'off') return false;
  }
  return true;
}

export default function AppFreshness() {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [pull, setPull] = useState<PullUi>({ phase: 'idle' });
  const coordinatorRef = useRef<FreshnessCoordinator | null>(null);
  const routerRef = useRef(router);
  routerRef.current = router;
  const pullRef = useRef(pull);
  pullRef.current = pull;

  // ── Lifecycle → coordinator ──
  useEffect(() => {
    const isHidden = () => document.visibilityState === 'hidden';
    const coordinator = createFreshnessCoordinator({
      isHidden,
      onCatchUp: (reason) => {
        // Subscribers first: the mission page captures its scroll anchor here.
        emitCatchUp(reason);
        startTransition(() => routerRef.current.refresh());
      },
    });
    coordinatorRef.current = coordinator;
    const unregister = setActiveCoordinator(coordinator);

    const onVisibility = () => {
      if (isHidden()) coordinator.onHidden();
      else coordinator.onForeground('visible');
    };
    const onHidden = () => coordinator.onHidden();
    const onResume = () => coordinator.onForeground('resume');
    const onPageShow = (e: PageTransitionEvent) => coordinator.onForeground('pageshow', { persisted: e.persisted });
    const onFocus = () => coordinator.onForeground('focus');
    const onOnline = () => coordinator.demand('online');

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', onHidden);
    document.addEventListener('resume', onResume);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);

    // Pusher is the fast path: a dropped socket lost whatever was published
    // while it was down, so a reconnect owes one catch-up.
    const connection = getPusherClient()?.connection;
    const isReconnect = createReconnectDetector();
    const onStateChange = (states: { previous: string; current: string }) => {
      if (isReconnect(states)) coordinator.demand('reconnect');
    };
    connection?.bind('state_change', onStateChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onHidden);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      connection?.unbind('state_change', onStateChange);
      unregister();
      coordinator.dispose();
      coordinatorRef.current = null;
    };
  }, []);

  // ── Back/forward: the router serves those from its cache ──
  const poppedRef = useRef(false);
  const seenPathRef = useRef(pathname);
  useEffect(() => {
    const onPop = () => { poppedRef.current = true; };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (seenPathRef.current === pathname) return;
    seenPathRef.current = pathname;
    if (!poppedRef.current) return;
    poppedRef.current = false;
    coordinatorRef.current?.demand('history');
  }, [pathname]);

  // ── Pull-to-refresh ──
  useEffect(() => {
    const root = findScrollRoot(document);
    if (root === document.body) return;
    const tracker = createPullTracker();

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      tracker.start(t.clientX, t.clientY, {
        atTop: atTop(root, e.target),
        // An open sheet locks the root; a pull in flight finishes first.
        enabled: root.style.overflow !== 'hidden' && pullRef.current.phase === 'idle',
        touches: e.touches.length,
      });
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const m = tracker.move(t.clientX, t.clientY);
      if (!m.consume) return;
      if (e.cancelable) e.preventDefault();
      setPull({ phase: 'pulling', distance: m.distance, armed: m.armed });
    };
    const onEnd = () => {
      const wasPulling = tracker.phase === 'pulling';
      if (tracker.end()) {
        setPull({ phase: 'refreshing' });
        coordinatorRef.current?.request('pull');
      } else if (wasPulling) {
        setPull({ phase: 'idle' });
      }
    };
    const onCancel = () => {
      if (tracker.phase === 'pulling') setPull({ phase: 'idle' });
      tracker.cancel();
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a claimed pull must stop the page scrolling under it.
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onCancel);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onCancel);
    };
  }, []);

  // A pull is done when its transition's render has committed.
  const sawPendingRef = useRef(false);
  useEffect(() => {
    if (pull.phase !== 'refreshing') {
      sawPendingRef.current = false;
      return;
    }
    if (isPending) {
      sawPendingRef.current = true;
      return;
    }
    if (sawPendingRef.current) setPull({ phase: 'done' });
  }, [pull.phase, isPending]);
  useEffect(() => {
    if (pull.phase !== 'done') return;
    const t = setTimeout(() => setPull({ phase: 'idle' }), DONE_MS);
    return () => clearTimeout(t);
  }, [pull.phase]);

  const offset =
    pull.phase === 'pulling' ? pull.distance : pull.phase === 'idle' ? 0 : PULL_THRESHOLD_PX;
  const label =
    pull.phase === 'refreshing'
      ? 'Refreshing…'
      : pull.phase === 'done'
        ? 'Up to date'
        : pull.phase === 'pulling'
          ? pull.armed ? 'Release to refresh' : 'Pull to refresh'
          : '';

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only" data-testid="pull-refresh-status">
        {pull.phase === 'refreshing' || pull.phase === 'done' ? label : ''}
      </span>
      {pull.phase !== 'idle' && (
        <div
          aria-hidden="true"
          data-testid="pull-refresh-indicator"
          data-phase={pull.phase}
          className="pointer-events-none fixed inset-x-0 z-20 flex justify-center md:hidden"
          style={{
            top: 'env(safe-area-inset-top, 0px)',
            transform: `translateY(${offset - 40}px)`,
            transition: pull.phase === 'pulling' ? 'none' : 'transform 180ms ease-out',
          }}
        >
          <div className="flex min-h-9 items-center gap-2 border-2 border-border-strong bg-card px-3 font-mono text-[12px] font-semibold text-text-primary shadow-[var(--card-shadow)]">
            {pull.phase === 'refreshing' ? (
              <Spinner size="xs" aria-label="Refreshing" />
            ) : (
              <span
                className="inline-block transition-transform"
                style={{ transform: pull.phase === 'pulling' && pull.armed ? 'rotate(180deg)' : undefined }}
              >
                {pull.phase === 'done' ? '✓' : '↓'}
              </span>
            )}
            <span>{label}</span>
          </div>
        </div>
      )}
    </>
  );
}
