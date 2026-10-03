import Link from 'next/link';
import type { MouseEventHandler, ReactNode } from 'react';
import Spinner from '@/components/Spinner';

interface BaseProps {
  children: ReactNode;
  /** Shows the block-ticker spinner and disables the action. */
  pending?: boolean;
  disabled?: boolean;
  tone?: 'primary' | 'danger';
  fullWidthOnMobile?: boolean;
  className?: string;
  'data-testid'?: string;
}

type LinkProps = BaseProps & { href: string; onClick?: never; type?: never };
type ButtonProps = BaseProps & {
  href?: never;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: 'button' | 'submit';
};

export type PrimaryActionProps = LinkProps | ButtonProps;

/** Classes for the action; exported so the sizing contract is testable. */
export function primaryActionClass({
  tone = 'primary',
  fullWidthOnMobile = false,
  className = '',
}: Pick<BaseProps, 'tone' | 'fullWidthOnMobile' | 'className'>): string {
  // `.btn-lg` is 40px; h-11 lifts it to the 44px touch target below md.
  return [
    'btn btn-lg h-11 md:h-10',
    tone === 'danger' ? 'btn-danger' : 'btn-primary',
    fullWidthOnMobile ? 'w-full md:w-auto' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The single most important action on a surface — at most one per screen or
 * sheet; everything else is `.btn` / `.btn-quiet`.
 */
export default function PrimaryAction(props: PrimaryActionProps) {
  const { children, pending = false, disabled = false, 'data-testid': testId } = props;
  const cls = primaryActionClass(props);
  const inactive = pending || disabled;
  const content = (
    <>
      {pending && <Spinner size="sm" aria-label="Working" />}
      {children}
    </>
  );

  if (props.href !== undefined) {
    if (inactive) {
      return (
        <span role="link" aria-disabled="true" aria-busy={pending || undefined} data-testid={testId} className={`${cls} opacity-40 cursor-not-allowed`}>
          {content}
        </span>
      );
    }
    return (
      <Link href={props.href} data-testid={testId} className={cls}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={inactive}
      aria-busy={pending || undefined}
      data-testid={testId}
      className={cls}
    >
      {content}
    </button>
  );
}

export { PrimaryAction };
