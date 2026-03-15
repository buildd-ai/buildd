/**
 * Shared page content wrapper that provides consistent max-width and padding
 * across all dashboard pages.
 *
 * Standard: max-w-5xl (1024px), consistent horizontal/vertical padding.
 * Use `className` to override or extend for special layouts (e.g. Home's two-column).
 */
export function PageContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-content ${className ?? ''}`}>
      {children}
    </div>
  );
}
