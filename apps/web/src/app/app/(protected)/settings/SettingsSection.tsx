import type { ReactNode } from 'react';

/**
 * One header + one card per settings section.
 *
 * Every section on this page used to hand-roll its own header row (mb-2 vs mb-3
 * vs mb-4, items-end vs items-center) and its own card padding, which made the
 * page read as a stack of unrelated widgets. Route new sections through here so
 * the rhythm stays identical.
 */
export default function SettingsSection({
  title, action, tone = 'default', children, bare = false,
}: {
  title: string;
  /** Right-aligned control in the header row (a link, a team picker). */
  action?: ReactNode;
  tone?: 'default' | 'danger';
  children: ReactNode;
  /** Skip the card wrapper — for sections that render their own list of cards. */
  bare?: boolean;
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3 min-h-8">
        <h2 className={`section-label ${tone === 'danger' ? 'text-status-error' : ''}`}>{title}</h2>
        {action}
      </div>
      {bare ? children : (
        <div className={`card p-4 space-y-4 ${tone === 'danger' ? 'border-status-error/40' : ''}`}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Sub-heading + optional description inside a section card. */
export function SettingsSubsection({
  title, description, children,
}: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        {description && <p className="text-xs text-text-secondary mt-1">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Horizontal run of .btn actions. */
export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
