import SettingsSubNav from './_components/SettingsSubNav';

/**
 * Every /app/settings/* page shares the sub-nav (desktop). On a phone the
 * sub-nav is hidden: /app/settings is the list, each section is a full page,
 * and the mobile header carries the back arrow (nav-config mobileBackHref).
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="md:flex min-h-full">
      <SettingsSubNav />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
