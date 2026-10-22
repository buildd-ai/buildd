import type { ReactNode } from 'react';

export interface PageColumnProps {
  children: ReactNode;
  as?: 'div' | 'section' | 'article';
  className?: string;
}

/**
 * A page's content column: centred and held to the reading width
 * (`--content-measure`, docs/design/design-system.md §2.6), never stretched to
 * the window, whether or not Ask is docked beside it (Navigation R-21).
 */
export default function PageColumn({ children, as: Tag = 'div', className = '' }: PageColumnProps) {
  return <Tag data-page-column="" className={`mx-auto w-full max-w-[var(--content-measure)] ${className}`.trim()}>{children}</Tag>;
}

export { PageColumn };
