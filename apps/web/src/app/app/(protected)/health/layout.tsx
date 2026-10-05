import { Suspense } from 'react';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import HealthSubNav from './_components/HealthSubNav';

/**
 * Every /app/health/* page shares the Health sub-nav, laid out like Settings.
 * The Operator item only exists for buildd platform operators.
 */
export default async function HealthLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser().catch(() => null);
  const isOperator = isPlatformOperator(user);
  return (
    <div className="md:flex min-h-full">
      {/* useSearchParams needs a boundary so the pages stay dynamic per request. */}
      <Suspense fallback={null}>
        <HealthSubNav isOperator={isOperator} />
      </Suspense>
      {/* Pages clear the fixed phone header with their own top padding; the
          link row already sits below the header, so pull the page up by the
          header's height to keep one gap, not two. */}
      <div className="flex-1 min-w-0 max-md:-mt-[var(--mobile-header-h,0px)]">{children}</div>
    </div>
  );
}
