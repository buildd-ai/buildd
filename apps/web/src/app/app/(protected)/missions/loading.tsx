import Skeleton, { SkeletonRoute } from '@/components/Skeleton';

/**
 * Mirrors the missions list's own container padding and layout (count line
 * with + New, search, chips, hairline rows) so the real page lands in the
 * same place the skeleton occupied.
 */
export default function MissionsLoading() {
  return (
    <SkeletonRoute label="Loading missions" className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <div className="hidden md:block mb-3">
        <Skeleton className="h-3 w-20 mb-1.5" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="flex items-center justify-between mb-5">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-16" />
      </div>
      <Skeleton className="h-9 w-full md:max-w-[420px] mb-2" />
      <div className="flex gap-1.5 mb-6">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-7 w-20 rounded-full" />)}
      </div>
      <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="border-t border-border-default py-3.5">
            <Skeleton className="h-4 w-3/4 mb-2.5" />
            <Skeleton className="h-2 w-1/2 mb-2.5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </SkeletonRoute>
  );
}
