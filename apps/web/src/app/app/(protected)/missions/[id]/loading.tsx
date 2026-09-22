import Skeleton, { SkeletonRoute } from '@/components/Skeleton';

/**
 * Mirrors mission detail's container (`px-4 md:px-10 pt-5 md:pt-8 pb-12
 * max-w-3xl`): breadcrumb, title, the situation block, then the task timeline.
 * This is the heaviest of the three surfaces, so it is also the one where
 * painting the frame first changes the most.
 */
export default function MissionDetailLoading() {
  return (
    <SkeletonRoute
      label="Loading mission"
      className="px-4 md:px-10 pt-5 md:pt-8 pb-12 max-w-3xl"
    >
      <Skeleton className="h-3 w-32 mb-4" />
      <Skeleton className="h-7 w-3/4 mb-6" />
      <div className="card p-4 mb-8">
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-3 w-20 mb-4" />
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </SkeletonRoute>
  );
}
