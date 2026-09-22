import Skeleton, { SkeletonRoute } from '@/components/Skeleton';

/**
 * Mirrors task detail's container (`p-4 md:p-8` / `max-w-4xl`): status chip and
 * title, the description block, then the worker/PR sections.
 */
export default function TaskDetailLoading() {
  return (
    <SkeletonRoute
      label="Loading task"
      className="p-4 md:p-8 overflow-x-hidden h-full"
    >
      <div className="max-w-4xl w-full">
        <div className="flex items-center gap-3 mb-4">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-7 w-2/3 mb-6" />
        <Skeleton className="h-16 w-full mb-8" />
        <Skeleton className="h-3 w-24 mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    </SkeletonRoute>
  );
}
