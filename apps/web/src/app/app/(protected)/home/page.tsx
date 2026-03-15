import { getCurrentUser } from '@/lib/auth-helpers';

export default async function HomePage() {
  const user = await getCurrentUser();
  const firstName = user?.name?.split(' ')[0] || 'there';

  // Determine greeting based on time (server-side, UTC — close enough)
  const hour = new Date().getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8">
      {/* Greeting */}
      <h1 className="font-display italic text-[32px] md:text-[30px] text-text-primary leading-[1.1] tracking-[-0.02em]">
        {greeting}, {firstName}
      </h1>
      <p className="text-[15px] text-text-secondary mt-2 font-light">
        Your agents are standing by.
      </p>

      {/* Right Now — placeholder */}
      <div className="mt-6">
        <div className="section-label mb-3">Right Now</div>
        <div className="border-l-2 border-accent bg-card-rightnow rounded-r-[10px] px-4 py-3">
          <p className="text-[15px] text-text-secondary font-light">
            No active tasks right now.
          </p>
        </div>
      </div>

      {/* Missions — placeholder */}
      <div className="mt-7">
        <div className="flex items-baseline justify-between mb-3.5">
          <div className="section-label">Missions</div>
          <span className="text-xs text-text-secondary font-light">0 active</span>
        </div>
        <div className="card p-5 text-center">
          <p className="text-sm text-text-secondary">
            Create your first mission to get started.
          </p>
        </div>
      </div>

      {/* Activity — placeholder */}
      <div className="mt-7">
        <div className="section-label mb-3.5">Activity</div>
        <p className="text-sm text-text-muted">No recent activity.</p>
      </div>
    </div>
  );
}
