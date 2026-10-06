'use client';

/**
 * Follows each user turn of an open conversation with a TurnSignalTracker
 * (./turn-signal-tracker.ts) and posts its content-free record to
 * `/api/chat/[id]/turn-signal`: on the turn's end (after a short paint
 * grace), on pagehide (as a beacon), or when the view closes mid-turn.
 * The server keeps it only for teams with chat retro lessons on.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TurnSignal } from '@/lib/chat/turn-signal';
import { hasAnswerContent, RENDER_GRACE_MS, TurnSignalTracker, type ProbeResult, type TrackerEnv } from './turn-signal-tracker';

type Msg = { id: string; role: string; parts: ReadonlyArray<{ type: string }> };
type Status = 'ready' | 'submitted' | 'streaming' | 'error';

const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const sel = (id: string) => `[data-message-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`;

/**
 * What counts as the answer on screen: the feed's answer text (ChatFeed
 * AgentText), an approval card, or the kit's default text and cards.
 */
const ANSWER_SELECTOR = '[data-testid="feed-text"], [data-testid="approval-card"], [data-testid="approval-rows"], .kit-text, .kit-card';

/** The real DOM probe: the answer's text (or approval card) is in the page and laid out. */
export function domProbe(ref: string, assistantId: string): ProbeResult {
  const userEl = document.querySelector(sel(ref));
  if (userEl && !shown(userEl)) return 'pane_hidden';
  const msg = document.querySelector(sel(assistantId));
  if (!msg) return 'not_visible';
  for (const el of Array.from(msg.querySelectorAll(ANSWER_SELECTOR))) {
    if ((el.textContent ?? '').trim() && shown(el)) return 'visible';
  }
  return 'not_visible';
}

function browserEnv(conversationId: string): TrackerEnv {
  const url = `/api/chat/${conversationId}/turn-signal`;
  return {
    now: () => Date.now(),
    probe: domProbe,
    docHidden: () => document.visibilityState === 'hidden',
    online: () => navigator.onLine !== false,
    post: (ref: string, signal: TurnSignal, beacon: boolean) => {
      const body = JSON.stringify({ ref, signal });
      if (beacon && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      void fetch(url, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    },
  };
}

/** Returns `onStop`: call it when the person presses stop. */
export function useTurnSignal(args: { conversationId: string | null; messages: readonly Msg[]; status: Status; env?: TrackerEnv }): { onStop(): void } {
  const { conversationId, messages, status, env } = args;
  const tracker = useMemo(
    () => (conversationId ? new TurnSignalTracker(env ?? browserEnv(conversationId)) : null),
    [conversationId, env],
  );
  const prev = useRef<Status>(status);
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!tracker) return;
    const was = prev.current;
    prev.current = status;
    const busy = status === 'submitted' || status === 'streaming';
    const wasBusy = was === 'submitted' || was === 'streaming';

    let userIdx = messages.length - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (busy && !wasBusy && userIdx >= 0 && userIdx === messages.length - 1) tracker.submit(messages[userIdx].id);
    const ref = tracker.current;
    if (!ref) return;
    if (status === 'streaming') tracker.streaming();
    const refIdx = messages.findIndex(m => m.id === ref);
    const last = messages.at(-1);
    if (last && last.role === 'assistant' && refIdx >= 0 && messages.indexOf(last) > refIdx && hasAnswerContent(last.parts)) tracker.content(last.id);
    // Effects run after commit: the DOM now holds what this render drew.
    tracker.check();
    if (wasBusy && !busy) {
      tracker.end(status === 'error' ? 'error' : 'ready');
      if (grace.current) clearTimeout(grace.current);
      grace.current = setTimeout(() => { grace.current = null; tracker.finalize(); }, RENDER_GRACE_MS);
    }
  }, [tracker, messages, status]);

  useEffect(() => {
    if (!tracker) return;
    const onVisibility = () => tracker.visibilityChanged();
    const onPagehide = () => tracker.pagehide();
    const onOffline = () => tracker.flag('offline');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('offline', onOffline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPagehide);
      window.removeEventListener('offline', onOffline);
      if (grace.current) { clearTimeout(grace.current); grace.current = null; }
      // Closed or switched conversations mid-turn: whatever happened next, nobody was looking here.
      tracker.left();
    };
  }, [tracker]);

  const onStop = useCallback(() => { tracker?.flag('stopped'); }, [tracker]);
  return { onStop };
}
