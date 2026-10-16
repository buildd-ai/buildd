import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import type { HealthViewer } from '@/lib/health-nav';
import HealthSubNav from './_components/HealthSubNav';

/** Who is looking: Insights is listed for team admins, Operator for platform operators. Never fails the layout. */
async function healthViewer(): Promise<HealthViewer> {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return { operator: false, teamAdmin: false };
  const teamAdmin = await (async () => {
    const teamId = await resolveActiveTeamId(user.id, (await cookies()).get('buildd-team')?.value);
    return !!teamId && await can({ kind: 'user', userId: user.id }, 'view_team_usage', teamId);
  })().catch(() => false);
  return { operator: isPlatformOperator(user), teamAdmin };
}

/**
 * Every /app/health/* page shares the Health sub-nav, laid out like Settings.
 */
export default async function HealthLayout({ children }: { children: React.ReactNode }) {
  const viewer = await healthViewer();
  return (
    <div className="md:flex min-h-full">
      {/* useSearchParams needs a boundary so the pages stay dynamic per request. */}
      <Suspense fallback={null}>
        <HealthSubNav viewer={viewer} />
      </Suspense>
      {/* Pages clear the fixed phone header with their own top padding; the
          link row already sits below the header, so pull the page up by the
          header's height to keep one gap, not two. */}
      <div className="flex-1 min-w-0 max-md:-mt-[var(--mobile-header-h,0px)]">{children}</div>
    </div>
  );
}
