'use client';

interface PrLinkProps {
  href: string;
  prNumber: number | null | undefined;
  className?: string;
}

export default function PrLink({ href, prNumber, className }: PrLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={e => e.stopPropagation()}
    >
      PR #{prNumber}
    </a>
  );
}
