'use client';

import { useEffect } from 'react';
import { PRESENCE_BEAT_MS } from '@/lib/presence-shared';

const ENDPOINT = '/api/chat/presence';

/**
 * Invisible: tells buildd this person is looking at chat, so an event they
 * watch is not also pushed to their phone (lib/presence.ts).
 *
 * Beats on mount, on focus, on `visibilitychange` and every 30s, but only while
 * the tab is visible. Going hidden or closing the page sends one "not visible"
 * beat, as does leaving the chat page, so away starts at once instead of when
 * the 75s key lapses.
 */
export default function ChatPresenceBeat({ conversationId }: { conversationId: string | null }) {
  useEffect(() => {
    const send = (visible: boolean) => {
      const body = JSON.stringify({ visible, conversationId });
      if (!visible && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
      void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    };
    const beatIfVisible = () => { if (document.visibilityState === 'visible') send(true); };
    const onVisibility = () => send(document.visibilityState === 'visible');
    const onHide = () => send(false);

    beatIfVisible();
    const timer = setInterval(beatIfVisible, PRESENCE_BEAT_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', beatIfVisible);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', beatIfVisible);
      window.removeEventListener('pagehide', onHide);
      // Leaving chat for another page is not looking at chat.
      onHide();
    };
  }, [conversationId]);

  return null;
}
