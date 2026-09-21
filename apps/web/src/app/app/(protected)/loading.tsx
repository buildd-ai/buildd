import Skeleton, { SkeletonRoute } from '@/components/Skeleton';

/**
 * Default loading UI for every route under /app that does not define its own.
 *
 * Next wraps the segment's children in a Suspense boundary when this file
 * exists, so the shell — sidebar, header, banners — streams and paints while
 * the page's queries are still in flight. Without it the whole navigation
 * blocks on the slowest read in the page, which on these surfaces is a chain
 * of separate HTTP round trips to Postgres.
 *
 * Note this does not cover the shared layout's own reads: the layout resolves
 * before its children, so its waits are still ahead of anything here.
 */
export default function ProtectedLoading() {
  return (
    <SkeletonRoute label="Loading" className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <Skeleton className="h-5 w-40 mb-6" />
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </SkeletonRoute>
  );
}
