import Skeleton, { SkeletonRoute } from '@/components/Skeleton';

/**
 * Mirrors the missions list's own container padding and header row
 * (`px-4 sm:px-7 md:px-10 pt-14 md:pt-8`, title left / count right) so the
 * real page lands in the same place the skeleton occupied.
 */
export default function MissionsLoading() {
  return (
    <SkeletonRoute label="Loading missions" className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <Skeleton className="hidden md:block h-6 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="card p-4">
            <Skeleton className="h-4 w-1/2 mb-3" />
            <Skeleton className="h-2 w-full mb-2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </SkeletonRoute>
  );
}
