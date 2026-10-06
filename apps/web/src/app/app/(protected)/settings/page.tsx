import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { legacySettingsTarget, settingsNavFor } from '@/lib/settings-nav';
import LegacyAnchorRedirect from './_components/LegacyAnchorRedirect';

export const dynamic = 'force-dynamic';

/**
 * Settings index. On a phone this is the list half of list → detail: every
 * section, grouped, one tap each. On desktop the sub-nav already lists them, so
 * the same list doubles as an overview with a line on what each one holds.
 *
 * Old links: `?section=agent-backends` resolves here on the server;
 * `#agent-backends` resolves in the browser (LegacyAnchorRedirect).
 */
export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const { section } = await searchParams;
  const legacy = legacySettingsTarget(section);
  if (legacy) redirect(legacy);

  return (
    <div className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <LegacyAnchorRedirect />
      <div className="max-w-2xl space-y-7">
        <h1 className="hidden md:block text-xl font-semibold text-text-primary">Settings</h1>
        {settingsNavFor({ billing: isBillingEnforced() }).map((group) => (
          <section key={group.label} aria-labelledby={`settings-group-${group.label}`}>
            <h2 id={`settings-group-${group.label}`} className="section-label mb-2">{group.label}</h2>
            <ul className="card divide-y divide-border-default" data-testid="settings-index-group">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-surface-3 transition-colors"
                    data-testid={`settings-index-${item.id}`}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary">{item.label}</span>
                      <span className="block text-xs text-text-secondary mt-0.5">{item.description}</span>
                    </span>
                    <span aria-hidden className="text-text-muted shrink-0">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
