'use client';

/**
 * Avatar colour picker. The dots stay small (24/28px) but each gets a ≥44px
 * hit area below `md` via a transparent ::before, and the row's mobile gap is
 * sized so neighbouring hit areas abut instead of overlapping:
 *   sm: 24px dot + 2×10px inset = 44px, gap 20px → 44px pitch
 *   md: 28px dot + 2×8px inset  = 44px, gap 16px → 44px pitch
 * Eight swatches at 44px pitch (~336px) fit the 343px column of a 375px
 * phone; narrower screens wrap to a second row rather than overlap.
 */
export function ColorSwatches({
  colors,
  value,
  onChange,
  size = 'sm',
}: {
  colors: readonly string[];
  value: string;
  onChange: (c: string) => void;
  size?: 'sm' | 'md';
}) {
  const dot = size === 'md'
    ? 'w-7 h-7 before:-inset-2'
    : 'w-6 h-6 before:-inset-[10px]';
  const gap = size === 'md' ? 'gap-4' : 'gap-5';
  return (
    <div role="radiogroup" aria-label="Avatar colour" className={`flex flex-wrap ${gap} md:gap-2`}>
      {colors.map(c => {
        const selected = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={c}
            data-testid="color-swatch"
            onClick={() => onChange(c)}
            className={`relative ${dot} before:absolute md:before:hidden rounded-full transition-all ${
              selected ? 'ring-2 ring-offset-2 ring-text-primary scale-110' : 'hover:scale-110'
            }`}
            style={{ backgroundColor: c }}
          />
        );
      })}
    </div>
  );
}
