import Link from 'next/link';
import type { ReactNode } from 'react';

/** ok (green), warn (amber), err (red), info (neutral ink on the strong border; never orange). */
export type NoticeTone = 'ok' | 'warn' | 'err' | 'info';

/** The one action a notice may carry: a link or a button, drawn as `.btn`, never a primary fill. */
export type NoticeAction =
  | { label: string; href: string; onClick?: never }
  | { label: string; onClick: () => void; href?: never };

export interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  /** The body. */
  children?: ReactNode;
  action?: NoticeAction;
  className?: string;
  'data-testid'?: string;
}

/** A glyph per tone, so the notice never reads by colour alone. */
const GLYPH: Record<NoticeTone, string> = { ok: '✓', warn: '!', err: '✕', info: 'i' };

/**
 * The one inline alert (docs/design/design-system.md §4): a 1px frame in the
 * tone's hue on the card radius, no tint fill (state colours never fill a
 * card, §2.5). The look is the `.notice` / `.notice-<tone>` classes in
 * globals.css, so a hand-written `.notice` is the same box. `err` is
 * announced (`role="alert"`); every other tone is `role="status"`.
 */
export default function Notice({ tone = 'info', title, children, action, className = '', 'data-testid': testId }: NoticeProps) {
  return (
    <div
      className={`notice notice-${tone}${className ? ` ${className}` : ''}`}
      role={tone === 'err' ? 'alert' : 'status'}
      data-tone={tone}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          {title && (
            <p data-testid="notice-title" className="font-semibold">
              <span aria-hidden="true" className="mr-1.5 font-mono">{GLYPH[tone]}</span>{title}
            </p>
          )}
          {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
        </div>
        {action && (action.href !== undefined
          ? <Link className="btn btn-sm" href={action.href} data-testid="notice-action">{action.label}</Link>
          : <button type="button" className="btn btn-sm" onClick={action.onClick} data-testid="notice-action">{action.label}</button>)}
      </div>
    </div>
  );
}

export { Notice };
