import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { legacySettingsTarget, settingsNavFor } from '@/lib/settings-nav';
import Eyebrow from '@/components/ui/Eyebrow';
import Lede from '@/components/ui/Lede';
import LegacyAnchorRedirect from './_components/LegacyAnchorRedirect';

export const dynamic = 'force-dynamic';

/**
 * Settings index. On a phone this is the list half of list → detail: every
 * section, grouped, one tap each. On desktop the sub-nav already lists them, so
 * the page is a short landing: one sentence, then the same list as unframed
 * rows with a line on what each one holds.
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
        <header className="hidden md:block">
          <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
          <Lede className="mt-1.5">Pick a section here or in the column on the left.</Lede>
        </header>
        {settingsNavFor({ billing: isBillingEnforced() }).map((group) => (
          <section key={group.label} aria-labelledby={`settings-group-${group.label}`}>
            <Eyebrow as="h2" tone="muted" id={`settings-group-${group.label}`} className="mb-1">{group.label}</Eyebrow>
            <ul className="divide-y divide-border-default" data-testid="settings-index-group">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 py-3 min-h-14 hover:bg-[var(--q-tint)] transition-colors"
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
