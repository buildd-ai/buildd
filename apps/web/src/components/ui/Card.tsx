import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

/** Padding scale: `sm` 12px for dense lists, `md` 16px (default) for a standalone card. */
export type CardPadding = 'sm' | 'md';

const PADDING: Record<CardPadding, string> = { sm: 'p-3', md: 'p-4' };

type CardOwnProps<E extends ElementType> = {
  /** Element to render: `div` (default), `section`, `article`, `li`, or a `Link`. */
  as?: E;
  padding?: CardPadding;
  /** A linked or clickable card: the hover fill and a visible keyboard focus ring. */
  interactive?: boolean;
  /** No frame, only the padding: for a card nested inside another card. */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
};

export type CardProps<E extends ElementType = 'div'> = CardOwnProps<E> &
  Omit<ComponentPropsWithoutRef<E>, keyof CardOwnProps<E>>;

/**
 * The L2 card (docs/design/design-system.md §1, §4): a 1px hairline
 * on `--card`, the 6px card radius, flat. The look lives in the
 * `.card` class in globals.css, so `<Card>` and a hand-written `.card` are the
 * same card. A decision is L3 (`.card-decision`), not a Card.
 */
export default function Card<E extends ElementType = 'div'>({
  as, padding = 'md', interactive = false, bare = false, className = '', children, ...rest
}: CardProps<E>) {
  const Tag: ElementType = as ?? 'div';
  const cls = [
    bare ? null : 'card',
    !bare && interactive ? 'card-interactive' : null,
    PADDING[padding],
    className || null,
  ].filter(Boolean).join(' ');
  return <Tag className={cls} {...rest} data-card={bare ? undefined : '2'}>{children}</Tag>;
}

export { Card };
