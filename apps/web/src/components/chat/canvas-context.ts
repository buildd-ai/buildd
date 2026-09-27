'use client';

/**
 * The summoned canvas's handle (ChatCanvas.tsx), in its own module so the
 * entry points (ChatEntry.tsx) can open it without importing the canvas.
 */
import { createContext, useContext } from 'react';
import type { CanvasScope } from '@/lib/chat/canvas-scope';

export interface ChatCanvasApi {
  /** Open the canvas. No scope = the current page's. */
  open(scope?: Partial<CanvasScope>): void;
  close(): void;
  isOpen: boolean;
}

export const CanvasContext = createContext<ChatCanvasApi | null>(null);

/** Null outside the protected layout, or with chat unavailable. */
export function useChatCanvas(): ChatCanvasApi | null {
  return useContext(CanvasContext);
}
