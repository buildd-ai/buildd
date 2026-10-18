'use client';

/**
 * Refresh when a Pusher event says the data changed; poll only as the
 * once-a-minute fallback, never while the tab is hidden (spec 3ef37387 R-21).
 * The policy lives in lib/live-listen.ts.
 *
 * `channel` null (not known yet, or Pusher not configured) still keeps the
 * fallback read, so a surface never goes stale for want of a socket.
 */
import { useEffect, useRef } from 'react';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import { createLiveListener } from '@/lib/live-listen';

export interface UseLiveListenOptions {
  /** Full channel name (with CHANNEL_PREFIX), or null for fallback-only. */
  channel: string | null;
  events: readonly string[];
  /** Keep only the events about this surface (e.g. this release, this worker). */
  match?: (data: unknown) => boolean;
  refresh(): void;
  /** Off: no listening and no fallback. */
  enabled?: boolean;
  /** Off: events only, no once-a-minute read (e.g. nothing in flight to watch). */
  fallback?: boolean;
}

export function useLiveListen({ channel, events, match, refresh, enabled = true, fallback = true }: UseLiveListenOptions): void {
  const refreshRef = useRef(refresh);
  const matchRef = useRef(match);
  refreshRef.current = refresh;
  matchRef.current = match;
  const eventsKey = events.join('|');

  useEffect(() => {
    if (!enabled) return;
    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const listener = createLiveListener({ refresh: () => refreshRef.current(), isHidden, ...(fallback ? {} : { fallbackMs: null }) });
    listener.start();

    const onVisibility = () => listener.visible();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    const names = eventsKey ? eventsKey.split('|') : [];
    const handler = (data: unknown) => {
      if (matchRef.current && !matchRef.current(data)) return;
      listener.event();
    };
    const sub = channel ? subscribeToChannel(channel) : null;
    if (sub) for (const name of names) sub.bind(name, handler);

    return () => {
      listener.dispose();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (sub && channel) {
        for (const name of names) sub.unbind(name, handler);
        unsubscribeFromChannel(channel);
      }
    };
  }, [channel, eventsKey, enabled, fallback]);
}
