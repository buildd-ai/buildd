'use client';

/**
 * The open conversation pulls its fired watches (lib/chat/watch-delivery.ts):
 * once on open, again whenever the tab becomes visible, and every
 * WATCH_POLL_MS while it stays visible. A hidden tab never polls. When
 * something was delivered, `onDelivered` refetches the conversation (the
 * server also pings its channel, which covers other tabs and devices).
 */
import { useEffect, useRef } from 'react';

export const WATCH_POLL_MS = 30_000;

export function useWatchDelivery(conversationId: string | null | undefined, onDelivered: () => void) {
  const cb = useRef(onDelivered);
  cb.current = onDelivered;

  useEffect(() => {
    if (!conversationId) return;
    let stopped = false;
    let inflight = false;
    const drain = async () => {
      if (stopped || inflight || document.visibilityState !== 'visible') return;
      inflight = true;
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/deliveries`, { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { delivered?: number } | null;
          if (!stopped && (data?.delivered ?? 0) > 0) cb.current();
        }
      } catch {
        // Offline or a deploy in flight: the next poll tries again.
      } finally {
        inflight = false;
      }
    };
    void drain();
    const timer = setInterval(() => { void drain(); }, WATCH_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void drain(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [conversationId]);
}
