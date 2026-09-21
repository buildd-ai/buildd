/**
 * Placeholder block for a route's `loading.tsx`.
 *
 * Square corners and a flat fill on purpose — the design system sets
 * `border-radius: 0` on cards and uses 2px borders (globals.css), so a rounded,
 * shimmering skeleton would read as a different product while it was on screen.
 * `animate-status-pulse` is the existing opacity pulse rather than a new
 * animation.
 *
 * Decorative: announce the loading state once on the route's wrapper, not once
 * per block, so a screen reader does not read out a dozen placeholders.
 */
export default function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`bg-border-default animate-status-pulse ${className}`} />;
}

/** Wrapper that announces one loading state for a whole route skeleton. */
export function SkeletonRoute({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      {children}
    </div>
  );
}
