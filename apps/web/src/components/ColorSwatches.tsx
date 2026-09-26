'use client';

/** Role avatar palette. Names are what assistive tech announces. */
export const ROLE_COLORS = [
  { value: '#D4724A', name: 'Terracotta' },
  { value: '#5B7BB3', name: 'Blue' },
  { value: '#6B8E5E', name: 'Green' },
  { value: '#C4963B', name: 'Ochre' },
  { value: '#9B59B6', name: 'Purple' },
  { value: '#2C8C99', name: 'Teal' },
  { value: '#D4A24A', name: 'Amber' },
  { value: '#8A8478', name: 'Stone' },
] as const;

export const ROLE_COLOR_VALUES: readonly string[] = ROLE_COLORS.map(c => c.value);

/**
 * Avatar colour picker: a group of toggle buttons (aria-pressed). Plain
 * buttons rather than a radiogroup, so Tab/Space/Enter work without having to
 * implement roving tabindex + arrow keys.
 *
 * The dots stay small (24/28px) but each gets a 44px hit area below `md` via a
 * transparent ::before, and the row's mobile gap is sized so neighbouring hit
 * areas abut instead of overlapping:
 *   sm: 24px dot + 2×10px inset = 44px, gap 20px → 44px pitch
 *   md: 28px dot + 2×8px inset  = 44px, gap 16px → 44px pitch
 * The selected dot is scale-110, which scales its ::before too, so its inset
 * is reduced to keep the hit area at 44px (sm 2×8, md 2×6, ×1.1 = 44).
 * Eight md swatches at 44px pitch (~336px) fit the 343px column of a 375px
 * phone; narrower screens wrap to a second row rather than overlap.
 */
export function ColorSwatches({
  value,
  onChange,
  size = 'sm',
}: {
  value: string;
  onChange: (c: string) => void;
  size?: 'sm' | 'md';
}) {
  const dot = size === 'md' ? 'w-7 h-7' : 'w-6 h-6';
  const inset = size === 'md'
    ? { idle: 'before:-inset-2', selected: 'before:-inset-1.5' }
    : { idle: 'before:-inset-[10px]', selected: 'before:-inset-2' };
  // md: one row on a 375px phone. sm lives in narrower form cards (~300px),
  // where 8×44px can't fit, so it lays out as two even rows of four instead
  // of wrapping 7+1.
  const layout = size === 'md'
    ? 'flex flex-wrap gap-4'
    : 'grid grid-cols-4 w-fit gap-5 md:flex';
  return (
    <div role="group" aria-label="Avatar colour" className={`${layout} md:gap-2`}>
      {ROLE_COLORS.map(({ value: c, name }) => {
        const selected = value === c;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={selected}
            aria-label={name}
            title={name}
            data-testid="color-swatch"
            onClick={() => onChange(c)}
            className={`relative ${dot} ${selected ? inset.selected : inset.idle} before:absolute md:before:hidden rounded-full transition-all ${
              selected ? 'ring-2 ring-offset-2 ring-text-primary scale-110' : 'md:hover:scale-110'
            }`}
            style={{ backgroundColor: c }}
          />
        );
      })}
    </div>
  );
}
