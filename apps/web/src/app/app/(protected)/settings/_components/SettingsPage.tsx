import type { ReactNode } from 'react';
import { TEAM_MANAGED_LINE } from '@/lib/settings-nav';

/**
 * Page frame for one settings section. On a phone the shell's mobile header
 * already shows the section name and the back arrow, so the h1 is desktop-only
 * and the description sits at the top of the content. With no description the
 * whole header is desktop-only. A page about one named thing (a workspace)
 * whose mobile header only shows the list it came from sets `titleOnMobile`.
 *
 * A team page the viewer cannot change sets `readOnly`: one line under the
 * description says who manages it, and the page's sections render values with
 * no controls. Nothing per control says so (settingsReadOnly, settings-nav).
 */
export default function SettingsPage({
  title, description, children, wide = false, titleOnMobile = false, readOnly = false,
}: {
  title: string;
  /** The viewer holds none of the page's permissions: say who manages it. */
  readOnly?: boolean;
  /** Show the h1 on phones too: the mobile header names the parent list, not this item. */
  titleOnMobile?: boolean;
  description?: ReactNode;
  children: ReactNode;
  /** Two-column sections (model tiers) need more than the reading width. */
  wide?: boolean;
}) {
  return (
    <div className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className={`${wide ? 'max-w-5xl' : 'max-w-2xl'} space-y-8`}>
        {/* With no description the header is empty on a phone; drop it there so
            `space-y-8` doesn't leave a blank gap above the content. */}
        <header className={description || titleOnMobile || readOnly ? undefined : 'hidden md:block'}>
          <h1 className={`${titleOnMobile ? 'text-lg md:text-xl break-words' : 'hidden md:block text-xl'} font-semibold text-text-primary`}>{title}</h1>
          {description && (
            <p className={`text-sm text-text-secondary ${titleOnMobile ? 'mt-1' : ''} md:mt-1.5 max-w-prose`}>{description}</p>
          )}
          {readOnly && (
            <p data-testid="settings-read-only" className={`text-sm text-text-muted ${description || titleOnMobile ? 'mt-1' : ''} md:mt-1.5`}>{TEAM_MANAGED_LINE}</p>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
