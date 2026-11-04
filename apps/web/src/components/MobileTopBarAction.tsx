'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MOBILE_TOP_BAR_ACTION_ID } from './MobileTopBar';

/**
 * A page's one create action, placed in the phone top bar's trailing slot
 * (before the workspace glyph and avatar) rather than on a row of its own
 * under the bar. The page keeps its own desktop copy (`hidden md:…`); the bar
 * is `md:hidden`, so this shows on phones only. Renders nothing until mounted
 * and nothing where the shell has no bar (detail pages).
 */
export default function MobileTopBarAction({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(document.getElementById(MOBILE_TOP_BAR_ACTION_ID));
  }, []);
  return host ? createPortal(children, host) : null;
}
