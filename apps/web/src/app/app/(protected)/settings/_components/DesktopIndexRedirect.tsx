'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * On desktop the sub-nav already lists every section, so the index would show
 * the same list twice. Send wide viewports to the first section; a phone keeps
 * the index as its list half of list → detail.
 */
export default function DesktopIndexRedirect({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) router.replace(href);
  }, [router, href]);
  return null;
}
