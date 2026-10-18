'use client';

import { useEffect } from 'react';

/**
 * Opens the <details> around `#id` when the page is opened at that fragment, then scrolls it
 * into view. Browsers that reveal a closed disclosure on fragment navigation already do this;
 * this covers the ones that do not (R-43: the review status link lands on the open findings).
 */
export default function OpenAtHash({ id }: { id: string }) {
  useEffect(() => {
    const reveal = () => {
      if (decodeURIComponent(window.location.hash.slice(1)) !== id) return;
      const el = document.getElementById(id);
      if (!el) return;
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
      el.scrollIntoView({ block: 'start' });
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [id]);
  return null;
}
