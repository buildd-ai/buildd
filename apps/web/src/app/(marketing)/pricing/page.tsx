import Link from 'next/link';

const tiers = [
  {
    name: 'Open Source',
    price: '$0',
    period: '',
    subtitle: 'For open source projects',
    badge: 'Most Popular',
    cta: { label: 'Get Started', href: '/app', disabled: false },
    highlighted: true,
    features: [
      'Unlimited public repo workspaces',
      'Unlimited concurrent workers',
      'Unlimited tasks',
      'Unlimited cron schedules',
      'Workspace memory',
      'Skills system',
      'GitHub Actions workers',
    ],
  },
  {
    name: 'Pro',
    price: '$19',
    period: '/mo',
    subtitle: 'For private repositories',
    badge: null,
    cta: { label: 'Coming Soon', href: '#', disabled: true },
    highlighted: false,
    features: [
      'Everything in Open Source',
      'Private repository support',
      'Org repo support (GitHub orgs)',
      'Up to 10 concurrent workers',
      'Priority support',
    ],
  },
  {
    name: 'Team',
    price: '$39',
    period: '/user/mo',
    subtitle: 'For teams building together',
    badge: null,
    note: 'Minimum 2 seats',
    cta: { label: 'Coming Soon', href: '#', disabled: true },
    highlighted: false,
    features: [
      'Everything in Pro',
      'Multi-user workspaces',
      'User invitations + RBAC',
      'Team activity feed',
      'Shared memory across team',
      'Admin controls',
      'Up to 25 workers/workspace',
      'GitHub org-wide installation',
    ],
  },
] as const;

const comparisonRows = [
  { feature: 'Public repos', free: 'Unlimited', pro: true, team: true },
  { feature: 'Private repos', free: false, pro: 'Unlimited', team: 'Unlimited' },
  { feature: 'Org repos', free: false, pro: true, team: true },
  { feature: 'Concurrent workers', free: 'Unlimited', pro: '10', team: '25/workspace' },
  { feature: 'Tasks', free: 'Unlimited', pro: 'Unlimited', team: 'Unlimited' },
  { feature: 'Cron schedules', free: 'Unlimited', pro: 'Unlimited', team: 'Unlimited' },
  { feature: 'GitHub Actions workers', free: true, pro: true, team: true },
  { feature: 'Workspace memory', free: true, pro: true, team: true },
  { feature: 'Skills', free: true, pro: true, team: true },
  { feature: 'Team permissions', free: false, pro: false, team: true },
  { feature: 'User invitations', free: false, pro: false, team: true },
] as const;

function CellValue({ value }: { value: boolean | string }) {
  if (value === true) return <span className="text-green-400">&#10003;</span>;
  if (value === false) return <span className="text-gray-600">&mdash;</span>;
  return <span className="text-gray-200">{value}</span>;
}

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-[#2a2d3a] text-white">
      {/* Alpha Banner */}
      <div className="bg-indigo-600 text-center text-sm py-2 px-4">
        Alpha &mdash; Everything is free while we&apos;re in alpha. All features unlocked for all users.
      </div>

      {/* Nav */}
      <div className="max-w-6xl mx-auto px-6 py-6 flex justify-between items-center">
        <Link href="/" className="text-xl font-bold">buildd</Link>
        <div className="flex gap-6 text-sm text-gray-400">
          <Link href="/pricing" className="text-white">Pricing</Link>
          <Link href="/app" className="hover:text-white transition-colors">Sign In</Link>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-16 text-center">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
          Simple, honest pricing
        </h1>
        <p className="text-xl text-gray-300 max-w-2xl mx-auto">
          Free forever for open source. Pay when you go private.
        </p>
      </div>

      {/* Tier Cards */}
      <div className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid md:grid-cols-3 gap-6">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`rounded-xl p-6 md:p-8 border ${
                tier.highlighted
                  ? 'border-fuchsia-500/50 bg-fuchsia-500/5 ring-1 ring-fuchsia-500/20'
                  : 'border-white/10 bg-white/5'
              } flex flex-col relative`}
            >
              {tier.badge && (
                <span className="absolute -top-3 left-6 px-3 py-1 text-xs font-semibold bg-fuchsia-500 text-white rounded-full">
                  {tier.badge}
                </span>
              )}

              <div className="mb-6">
                <h3 className="text-xl font-semibold mb-1">{tier.name}</h3>
                <p className="text-sm text-gray-400">{tier.subtitle}</p>
              </div>

              <div className="mb-6">
                <span className="text-4xl font-bold">{tier.price}</span>
                {tier.period && <span className="text-gray-400 ml-1">{tier.period}</span>}
                {'note' in tier && tier.note && (
                  <p className="text-xs text-gray-500 mt-1">{tier.note}</p>
                )}
              </div>

              {tier.cta.disabled ? (
                <span className="block text-center px-6 py-3 border border-white/20 text-gray-500 rounded-lg mb-8 cursor-not-allowed">
                  {tier.cta.label}
                </span>
              ) : (
                <Link
                  href={tier.cta.href}
                  className="block text-center px-6 py-3 bg-fuchsia-500 hover:bg-fuchsia-400 text-white font-semibold rounded-lg transition-colors mb-8"
                >
                  {tier.cta.label}
                </Link>
              )}

              <ul className="space-y-3 flex-1">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-300">
                    <svg className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Comparison Table */}
      <div className="max-w-4xl mx-auto px-6 pb-20">
        <h2 className="text-2xl font-bold text-center mb-8">Feature comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-3 pr-4 text-gray-400 font-medium">Feature</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Open Source</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Pro</th>
                <th className="text-center py-3 px-4 text-gray-400 font-medium">Team</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.feature} className="border-b border-white/5">
                  <td className="py-3 pr-4 text-gray-300">{row.feature}</td>
                  <td className="py-3 px-4 text-center"><CellValue value={row.free} /></td>
                  <td className="py-3 px-4 text-center"><CellValue value={row.pro} /></td>
                  <td className="py-3 px-4 text-center"><CellValue value={row.team} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ */}
      <div className="max-w-3xl mx-auto px-6 pb-20">
        <h2 className="text-2xl font-bold text-center mb-8">FAQ</h2>
        <div className="space-y-6">
          <div className="bg-white/5 rounded-lg p-6 border border-white/10">
            <h3 className="font-semibold mb-2">What happens when alpha ends?</h3>
            <p className="text-sm text-gray-300">
              You&apos;ll keep access to the free tier forever. We&apos;ll give 30 days notice before paid tiers activate.
            </p>
          </div>
          <div className="bg-white/5 rounded-lg p-6 border border-white/10">
            <h3 className="font-semibold mb-2">Can I use buildd on private repos now?</h3>
            <p className="text-sm text-gray-300">
              Yes! During alpha, all features including private repos are free.
            </p>
          </div>
          <div className="bg-white/5 rounded-lg p-6 border border-white/10">
            <h3 className="font-semibold mb-2">What counts as a public repo?</h3>
            <p className="text-sm text-gray-300">
              Any GitHub repository with public visibility.
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-400 text-sm">
              buildd &mdash; Open source task queue for AI agents
            </p>
            <div className="flex gap-6 text-sm text-gray-400">
              <a href="https://github.com/buildd-ai/buildd" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
              <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
              <a href="mailto:hello@buildd.dev" className="hover:text-white transition-colors">Contact</a>
              <Link href="/app" className="hover:text-white transition-colors">Sign In</Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
