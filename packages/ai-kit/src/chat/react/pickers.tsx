'use client';

/**
 * The composer's three toolbar controls: `ToolsMenu` (tool permissions),
 * `ScopePicker` (where the turn's tools point) and `TierPicker` (Auto or a
 * pinned tier). Each is a `Menu`. They are controlled: the app owns the state
 * and the fetches (e.g. `GET`/`PATCH` from `createPermissionsApi`).
 */
import type { ReactNode } from 'react';
import { allowedBadgeCount, type ToolPermissionRow } from '@builddai/ai-kit/chat/contract';
import { Menu, MenuOption } from './Menu';
import { tierLabel } from './model';

const LOCKED_LABEL: Record<ToolPermissionRow['mode'], string> = {
  ask: 'Ask first',
  allow: 'Allow',
  read: 'Read only',
  never: 'Never',
};

// ── Tools ─────────────────────────────────────────────────────────────────────

export interface ToolsMenuProps {
  /** One row per tool group (`groups.rows(allowed)` / `GET` permissions). Null while loading. */
  rows: readonly ToolPermissionRow[] | null;
  onChange(key: string, mode: 'ask' | 'allow'): void;
  /** A row whose change is in flight (its toggle is disabled). */
  busyKey?: string | null;
  /** Shown under the rows, e.g. "Not saved". */
  error?: ReactNode;
  title?: string;
  className?: string;
}

/** The toggle rows on their own, for a settings page. */
export function ToolRows({ rows, onChange, busyKey }: Pick<ToolsMenuProps, 'onChange' | 'busyKey'> & { rows: readonly ToolPermissionRow[] }) {
  return (
    <ul className="kit-rows" data-testid="kit-tools-rows">
      {rows.map(r => (
        <li key={r.key} className="kit-row" data-group={r.key} data-mode={r.mode} data-locked={r.locked || undefined}>
          <span className="kit-row-label" id={`kit-tool-${r.key}`}>{r.label}</span>
          {r.locked ? (
            <span className="kit-row-lock">{LOCKED_LABEL[r.mode]}</span>
          ) : (
            <span role="group" aria-labelledby={`kit-tool-${r.key}`} className="kit-toggle">
              {(['ask', 'allow'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={r.mode === m}
                  disabled={busyKey === r.key}
                  onClick={() => { if (r.mode !== m) onChange(r.key, m); }}
                >
                  {m === 'ask' ? 'Ask first' : 'Allow'}
                </button>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The `···` control. The badge counts groups set to Allow (`··· 2`); with none
 * it is just `···`.
 */
export function ToolsMenu({ rows, onChange, busyKey = null, error, title = 'Tools', className }: ToolsMenuProps) {
  const count = rows ? allowedBadgeCount(rows) : 0;
  return (
    <Menu
      label={count > 0 ? `${title}, ${count} allowed without asking` : title}
      title={title}
      align="end"
      className={className}
      testId="kit-tools"
      trigger={(
        <>
          <span aria-hidden="true">···</span>
          {count > 0 && <span className="kit-badge" data-testid="kit-tools-count">{count}</span>}
        </>
      )}
    >
      {rows ? <ToolRows rows={rows} onChange={onChange} busyKey={busyKey} /> : <p className="kit-menu-title">…</p>}
      {error && <p role="alert" className="kit-menu-error">{error}</p>}
    </Menu>
  );
}

// ── Scope ─────────────────────────────────────────────────────────────────────

export interface ScopeOption { id: string; name: string }

export interface ScopePickerProps {
  options: readonly ScopeOption[];
  /** The pinned scope; null = all (the turn may be routed per message). */
  value: string | null;
  onChange(id: string | null): void;
  /** Where the latest unpinned turn went, shown as "→ name". */
  routed?: ScopeOption | null;
  /** The "all" option's name. */
  allLabel?: string;
  title?: string;
  className?: string;
}

export function ScopePicker({ options, value, onChange, routed = null, allLabel = 'All', title = 'Scope', className }: ScopePickerProps) {
  const pinned = value ? options.find(o => o.id === value) ?? null : null;
  const shown = pinned ? `@ ${pinned.name}` : routed ? `→ ${routed.name}` : `@ ${allLabel.toLowerCase()}`;
  return (
    <Menu label={`${title}: ${pinned?.name ?? (routed ? `${allLabel}, routed to ${routed.name}` : allLabel)}`} title={title} className={className} testId="kit-scope" trigger={<><span>{shown}</span><span aria-hidden="true">▾</span></>}>
      {close => (
        <div role="radiogroup" aria-label={title}>
          <MenuOption checked={value === null} onSelect={() => { onChange(null); close(); }}>{allLabel}</MenuOption>
          {options.map(o => (
            <MenuOption key={o.id} checked={value === o.id} onSelect={() => { onChange(o.id); close(); }}>{o.name}</MenuOption>
          ))}
        </div>
      )}
    </Menu>
  );
}

// ── Tier ──────────────────────────────────────────────────────────────────────

export interface TierOption {
  tier: string;
  label?: string;
  /** e.g. "$0.02 / turn" from the plan's price. */
  price?: string;
}

export interface TierPickerProps {
  /** The pinned tier; null = Auto (the app picks per turn). */
  value: string | null;
  onChange(tier: string | null): void;
  /** The tier the latest turn ran on, shown as "Auto · Standard". */
  last?: string | null;
  options?: readonly TierOption[];
  title?: string;
  className?: string;
}

const DEFAULT_TIERS: TierOption[] = [{ tier: 'budget' }, { tier: 'standard' }, { tier: 'premium' }];

export function TierPicker({ value, onChange, last = null, options = DEFAULT_TIERS, title = 'Model tier', className }: TierPickerProps) {
  const labels = Object.fromEntries(options.filter(o => o.label).map(o => [o.tier, o.label!]));
  const shown = tierLabel(value, last, labels);
  return (
    <Menu label={`${title}: ${shown}`} title={title} align="end" className={className} testId="kit-tier" trigger={<><span>{shown}</span><span aria-hidden="true">▾</span></>}>
      {close => (
        <div role="radiogroup" aria-label={title}>
          <MenuOption checked={value === null} onSelect={() => { onChange(null); close(); }} meta="picks per turn">Auto</MenuOption>
          {options.map(o => (
            <MenuOption key={o.tier} checked={value === o.tier} meta={o.price} onSelect={() => { onChange(o.tier); close(); }}>
              {tierLabel(o.tier, null, labels)}
            </MenuOption>
          ))}
        </div>
      )}
    </Menu>
  );
}
