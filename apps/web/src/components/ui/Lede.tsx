import type { ReactNode } from 'react';

export interface LedeProps {
  children: ReactNode;
  as?: 'p' | 'div';
  className?: string;
}

/**
 * The one plain-language sentence that says what a page, card or sheet is
 * about (type role `lede`; copy rules in docs/design/design-system.md §5).
 */
export default function Lede({ children, as: Tag = 'p', className = '' }: LedeProps) {
  return <Tag className={`text-lede text-text-secondary max-w-prose ${className}`}>{children}</Tag>;
}

export { Lede };
