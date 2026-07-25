'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Internal <Link> that stops click propagation so it can sit inside a
 * navigating parent card without triggering it. Server components cannot
 * attach onClick themselves — use this instead of an inline onClick in
 * any server-rendered page.
 */
export default function InternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className={className}
    >
      {children}
    </Link>
  );
}
