import type { ReactNode } from 'react';

/** Id of the shell's content slot; Chat portals its crumbs into it. */
export const MOBILE_TOP_BAR_SLOT_ID = 'mobile-top-bar-slot';

/**
 * The one geometry every top-level phone route shares: fixed 56px height,
 * 16px gutters, 8px gap, 1px rule, `--chat-bar` material. Controls inside are
 * 44px. Routes fill the slots; they never size the bar.
 */
export const MOBILE_TOP_BAR_CLASS =
  'flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--chat-rule)] bg-[var(--chat-bar)] px-4';

/** Right-hand control cluster: same gap and height on every route. */
export const MOBILE_TOP_BAR_CONTROLS_CLASS = 'flex shrink-0 items-center gap-2';

/** Square 44px control (theme toggle, icon buttons) sitting inside the shell. */
export const MOBILE_TOP_BAR_CONTROL_CLASS =
  'flex h-11 w-11 items-center justify-center border border-[var(--chat-rule)] text-[var(--chat-text)]';

export default function MobileTopBar({
  leading,
  trailing,
  children,
  barRef,
}: {
  /** Left slot: page / scope identity. Takes the remaining width and truncates. */
  leading?: ReactNode;
  /** Right slot: controls (workspace glyph, theme, avatar). */
  trailing?: ReactNode;
  /** Replaces both slots (Chat portals its own content in). */
  children?: ReactNode;
  barRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={barRef} data-testid="mobile-page-header" className={`md:hidden ${MOBILE_TOP_BAR_CLASS}`}>
      {children ?? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-normal">{leading}</div>
          {trailing && <div className={MOBILE_TOP_BAR_CONTROLS_CLASS}>{trailing}</div>}
        </>
      )}
    </div>
  );
}
