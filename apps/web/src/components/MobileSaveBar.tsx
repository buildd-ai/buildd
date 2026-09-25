'use client';

/**
 * Sticky save action for long editor forms on phones. The desktop header keeps
 * its own Save button; below `md` that button is at the top of a very long
 * form, so this bar pins one to the bottom of the viewport instead.
 *
 * Save feedback renders here too: the editor's page-level error sits at the
 * top of the form, off-screen from a user who tapped this bar.
 *
 * Dirty tracking (pass `dirty`): the bar only appears while there is something
 * to save, or while it is reporting on a save (in flight, just saved, failed).
 * Its appearance is the "you have unsaved changes" signal, and a clean form
 * gets the ~70px of phone viewport back. Omit `dirty` for an always-on bar.
 *
 * Offset: the layout's <main> is the scroll container and already carries
 * `pb-16` for the fixed MissionsBottomNav (h-14 + 1px border). Sticky insets
 * are measured from the scrollport MINUS the scroll container's padding, so
 * `bottom: 0` already clears those 64px; only the home-indicator inset, which
 * the nav adds below itself and main's padding does not, is added here.
 */
export function MobileSaveBar({
  onSave,
  saving,
  disabled,
  error,
  saved,
  dirty,
  label = 'Save Changes',
}: {
  onSave: () => void;
  saving: boolean;
  disabled?: boolean;
  /** Last save error, shown inline above the button. */
  error?: string | null;
  /** True briefly after a successful save. */
  saved?: boolean;
  /** Form differs from its last-saved state. Undefined = not tracked. */
  dirty?: boolean;
  label?: string;
}) {
  const tracked = dirty !== undefined;
  if (tracked && !dirty && !saving && !saved && !error) return null;

  const showSaved = saved && !dirty;
  return (
    <div
      data-testid="mobile-save-bar"
      className="md:hidden sticky bottom-[env(safe-area-inset-bottom,0px)] z-10 -mx-4 mt-8 px-4 py-3 bg-surface-1/95 backdrop-blur border-t border-border-default"
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-status-error [overflow-wrap:anywhere]">{error}</p>
      )}
      <div className="flex items-center gap-3">
        {dirty && !saving && (
          <span data-testid="mobile-save-bar-dirty" className="flex-shrink-0 inline-flex items-center gap-1.5 text-sm text-text-secondary">
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-primary" />
            Unsaved changes
          </span>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || disabled || (tracked && !dirty)}
          className="flex-1 min-h-11 px-5 py-2 bg-primary text-white rounded-md text-base font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : showSaved ? <span role="status">Saved ✓</span> : label}
        </button>
      </div>
    </div>
  );
}

/**
 * The desktop (md+) header counterpart of MobileSaveBar: disabled while the
 * form is clean, with an "Unsaved changes" hint beside it while dirty.
 */
export function HeaderSaveButton({
  onSave,
  saving,
  saved,
  dirty,
  label = 'Save Changes',
}: {
  onSave: () => void;
  saving: boolean;
  saved?: boolean;
  dirty: boolean;
  label?: string;
}) {
  return (
    <div className="hidden md:flex flex-shrink-0 items-center gap-3">
      {dirty && !saving && (
        <span data-testid="header-save-dirty" className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-primary" />
          Unsaved changes
        </span>
      )}
      <button
        type="button"
        data-testid="header-save"
        onClick={onSave}
        disabled={saving || !dirty}
        title={!dirty && !saving ? 'No unsaved changes' : undefined}
        className="px-5 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50 disabled:hover:bg-primary transition-colors"
      >
        {saving ? 'Saving…' : saved && !dirty ? 'Saved ✓' : label}
      </button>
    </div>
  );
}
