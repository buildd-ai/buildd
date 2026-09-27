'use client';

import type { MouseEvent } from 'react';

type SwitchName =
  /** Accessible name (becomes aria-label). Name what it controls, not its state. */
  | { label: string; labelledBy?: never }
  /** id of a visible element that names the switch (becomes aria-labelledby). */
  | { labelledBy: string; label?: never };

export type SwitchProps = SwitchName & {
  checked: boolean;
  onChange: (next: boolean, event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Opt-in className that grows the switch's touch target to 44px tall below
 * `md` without changing its visual size or the row's layout (a transparent
 * pseudo-element extends the button's hit box).
 */
export const SWITCH_HIT_AREA =
  "before:absolute before:content-[''] before:-inset-x-1 before:-inset-y-3 md:before:hidden";

/**
 * The one on/off toggle. A name is a required prop so a switch can never be
 * announced as just "switch, on".
 */
export default function Switch({ checked, onChange, disabled, label, labelledBy, className = '' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={(e) => onChange(!checked, e)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center border-2 transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${
        checked ? 'bg-accent border-accent' : 'bg-surface-1 border-border-strong'
      } ${className}`}
    >
      {/* One square knob, no shadow: off = muted at the left, on = ink at the right. */}
      <span
        aria-hidden="true"
        className={`inline-block h-3 w-3 transition-transform duration-200 ${
          checked ? 'bg-[var(--on-accent)] translate-x-[18px]' : 'bg-text-muted translate-x-[2px]'
        }`}
      />
    </button>
  );
}
