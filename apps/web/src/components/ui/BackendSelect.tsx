'use client';

import type { AgentBackend } from '@buildd/shared';

export type BackendValue = AgentBackend | null;

interface Props {
  /** null = inherit / default (no explicit backend). */
  value: BackendValue;
  onChange: (value: BackendValue) => void;
  /** Label shown for the null option. Roles inherit; missions default to Claude. */
  inheritLabel?: string;
  disabled?: boolean;
  className?: string;
}

const OPTIONS: { value: BackendValue; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

/**
 * Segmented control for picking the agent backend (Claude vs Codex) with an
 * inherit/default option. Touch-friendly — used in role and mission forms on
 * both desktop and mobile.
 */
export function BackendSelect({ value, onChange, inheritLabel, disabled, className = '' }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Agent backend"
      className={`inline-flex w-full rounded-lg border border-border-default overflow-hidden ${className}`}
    >
      {OPTIONS.map((opt, i) => {
        const active = value === opt.value;
        const label = opt.value === null && inheritLabel ? inheritLabel : opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`flex-1 h-10 px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
              i > 0 ? 'border-l border-border-default' : ''
            } ${
              active
                ? 'bg-surface-3 text-text-primary'
                : 'bg-surface-1 text-text-secondary hover:text-text-primary'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
