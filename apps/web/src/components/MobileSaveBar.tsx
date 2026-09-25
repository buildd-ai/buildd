'use client';

/**
 * Sticky save action for long editor forms on phones. The desktop header keeps
 * its own Save button; below `md` that button is at the top of a very long
 * form, so this bar pins one to the bottom of the viewport instead.
 *
 * Offset: the layout's <main> is the scroll container and the fixed
 * MissionsBottomNav (h-14 + 1px border + the home-indicator inset) overlays
 * its bottom edge, so the bar sits 4rem + the safe-area inset above it.
 */
export function MobileSaveBar({
  onSave,
  saving,
  disabled,
  label = 'Save Changes',
}: {
  onSave: () => void;
  saving: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      data-testid="mobile-save-bar"
      className="md:hidden sticky bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] z-10 -mx-4 mt-8 px-4 py-3 bg-surface-1/95 backdrop-blur border-t border-border-default"
    >
      <button
        type="button"
        onClick={onSave}
        disabled={saving || disabled}
        className="w-full min-h-11 px-5 py-2 bg-primary text-white rounded-md text-base font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}
