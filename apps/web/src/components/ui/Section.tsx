import { Children, useId, type ReactNode } from 'react';
import Eyebrow from './Eyebrow';

export interface SectionProps {
  title: string;
  count?: number;
  action?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
}

/** True when `children` would render nothing (null, undefined, false, or an empty list). */
export function isEmptyChildren(children: ReactNode): boolean {
  return Children.toArray(children).length === 0;
}

/**
 * A titled block on a page: eyebrow heading, optional count and action on the
 * right. Renders nothing when it has no children, so an empty section never
 * leaves an orphaned header.
 */
export default function Section({ title, count, action, id, children, className = '' }: SectionProps) {
  const headingId = useId();
  if (isEmptyChildren(children)) return null;
  return (
    <section id={id} aria-labelledby={headingId} className={`py-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Eyebrow as="h2" id={headingId}>
          {title}
          {count != null && <span className="ml-2 text-text-muted">{count}</span>}
        </Eyebrow>
        {action}
      </div>
      {children}
    </section>
  );
}

export { Section };
