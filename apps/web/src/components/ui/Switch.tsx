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
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${
        checked ? 'bg-accent border-accent' : 'bg-surface-4 border-border-default'
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}
