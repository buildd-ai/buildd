'use client';

/**
 * The open conversation pulls its fired watches (lib/chat/watch-delivery.ts).
 * On open, and whenever the tab becomes visible again, it asks for a full
 * drain (`?open=1`). While it stays visible it polls again after the
 * `pollMs` the server returns: 30s normally, where the server only reaches
 * Postgres if a Redis flag says there is something to pull; longer when
 * Redis is unavailable. A hidden tab never polls. When something was
 * delivered, `onDelivered` refetches the conversation (the server also pings
 * its channel, which covers other tabs and devices).
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void drain(false); }, ms);
    };
    const drain = async (open: boolean) => {
      if (stopped || inflight || document.visibilityState !== 'visible') return;
      inflight = true;
      let next = WATCH_POLL_MS;
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/deliveries${open ? '?open=1' : ''}`, { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { delivered?: number; pollMs?: number } | null;
          if (typeof data?.pollMs === 'number' && data.pollMs >= 5_000) next = data.pollMs;
          if (!stopped && (data?.delivered ?? 0) > 0) cb.current();
        }
      } catch {
        // Offline or a deploy in flight: the next poll tries again.
      } finally {
        inflight = false;
        if (!stopped) schedule(next);
      }
    };
    void drain(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void drain(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [conversationId]);
}
