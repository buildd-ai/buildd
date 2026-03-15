import { getCurrentUser } from '@/lib/auth-helpers';

export default async function YouPage() {
  const user = await getCurrentUser();

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8">
      <h1 className="text-xl font-semibold text-text-primary mb-6">You</h1>

      {/* Profile section */}
      <div className="mb-7">
        <div className="section-label mb-3">Profile</div>
        <div className="card p-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-accent-soft flex items-center justify-center text-lg font-semibold text-accent-text border border-border-default">
              {user?.name?.[0]?.toUpperCase() || 'U'}
            </div>
            <div>
              <div className="text-[15px] font-medium text-text-primary">{user?.name || 'Unknown'}</div>
              <div className="text-xs text-text-secondary">{user?.email || ''}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Team section — placeholder */}
      <div className="mb-7">
        <div className="section-label mb-3">Your Team</div>
        <div className="card p-5">
          <p className="text-sm text-text-secondary">Team details will appear here.</p>
        </div>
      </div>

      {/* Runners section — placeholder */}
      <div className="mb-7">
        <div className="section-label mb-3">Runners</div>
        <div className="card p-5">
          <p className="text-sm text-text-secondary">Runner status will appear here.</p>
        </div>
      </div>

      {/* Connections section — placeholder */}
      <div className="mb-7">
        <div className="section-label mb-3">Connections</div>
        <div className="card p-5">
          <p className="text-sm text-text-secondary">Connected services will appear here.</p>
        </div>
      </div>
    </div>
  );
}
