'use client';

/**
 * A decision answered on another open page (Navigation R-16): the card there
 * folds to `Answered on <device> · <option>` instead of staying open. Pages in
 * one browser tell each other over a BroadcastChannel, keyed by the decision's
 * key. The server does not record which device answered, so a page in another
 * browser learns only through its normal refresh, which drops the question.
 */
import { useEffect, useState } from 'react';

const CHANNEL = 'buildd-decision-answered';

export interface AnsweredElsewhere { key: string; label: string; device: string; at: number; origin: string }

/** `phone` on a narrow viewport, else `desktop`. */
export function deviceLabel(): string {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop';
  } catch {
    return 'desktop';
  }
}

/** Tell the other open pages this decision was answered here. */
export function announceAnswered(key: string, label: string, origin: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ key, label, device: deviceLabel(), at: Date.now(), origin } satisfies AnsweredElsewhere);
    ch.close();
  } catch {
    // Non-fatal: the other page folds on its next refresh.
  }
}

/** The answer another open card (not `self`) gave this decision, or null. */
export function useAnsweredElsewhere(key: string, self: string): AnsweredElsewhere | null {
  const [seen, setSeen] = useState<AnsweredElsewhere | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let ch: BroadcastChannel;
    try { ch = new BroadcastChannel(CHANNEL); } catch { return; }
    ch.onmessage = (e: MessageEvent<AnsweredElsewhere>) => {
      if (e.data?.key === key && e.data.origin !== self) setSeen(e.data);
    };
    return () => ch.close();
  }, [key, self]);
  return seen;
}
