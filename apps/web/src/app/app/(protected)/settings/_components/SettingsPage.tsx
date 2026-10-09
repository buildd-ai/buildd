import type { ReactNode } from 'react';

/**
 * Page frame for one settings section. On a phone the shell's mobile header
 * already shows the section name and the back arrow, so the h1 is desktop-only
 * and the description sits at the top of the content. With no description the
 * whole header is desktop-only.
 */
export default function SettingsPage({
  title, description, children, wide = false,
}: {
  title: string;
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
        <header className={description ? undefined : 'hidden md:block'}>
          <h1 className="hidden md:block text-xl font-semibold text-text-primary">{title}</h1>
          {description && (
            <p className="text-sm text-text-secondary md:mt-1.5 max-w-prose">{description}</p>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
