'use client';

import { useEffect, useState } from 'react';

/** Below Tailwind's `md`: the width where the app swaps popovers for bottom sheets. */
export const MOBILE_MAX_WIDTH = 767;

/**
 * True below `md`. False during SSR and the first client render, so markup
 * hydrates identically and the sheet/popover choice happens after mount.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= MOBILE_MAX_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}
