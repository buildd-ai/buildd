'use client';

import type { ReactNode } from 'react';

/**
 * External <a> that stops click propagation so it can sit inside a
 * navigating parent (e.g. a task row <Link>) without triggering it.
 * Server components cannot attach onClick themselves — passing a handler
 * from a server component throws at RSC serialization time. Use this
 * instead of an inline <a onClick={...}> in any server-rendered page.
 */
export default function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={className}
    >
      {children}
    </a>
  );
}
