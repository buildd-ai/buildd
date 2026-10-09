'use client';

/**
 * The model picker for tiers and tier-pool arms (knowledge-base: buildd/design/tier-model-pools.md §2).
 *
 * Grouped by the key that pays (route) first, then by vendor inside
 * OpenRouter. The default view is the tier's price band, newest first, three
 * rows per vendor, with previews, dated snapshots, deprecations and
 * superseded releases hidden. Search is fuzzy across vendor and model and
 * spans everything. Rows carry `current`, `recommended` (buildd's own pick),
 * `cheapest` and `newest` badges, `$in/$out` per MTok and the context window;
 * the strip at the bottom compares the highlighted row with the current one.
 *
 * `mode="multi"` turns rows into checkboxes (pool arms): `locked` rows are
 * already in and count toward `max`, and the draft keeps the order the admin
 * picked, which is the priority order `onChange` receives.
 *
 * Named CatalogModelPicker because `components/ModelPicker.tsx` is the
 * role-level tier chooser.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { TIER_PRICE_BANDS, type CatalogTier } from '@buildd/core/model-catalog';
import { useIsMobile } from '@/hooks/useIsMobile';
import { AnchoredPopover } from '@/components/ui/AnchoredPopover';
import { triggerClasses } from '@/components/ui/Select';
import {
  buildPickerRows,
  compareRows,
  formatContext,
  formatPrice,
  groupPickerRows,
  pickerKey,
  vendorLabel,
  type Badge,
  type PickerModelInput,
  type PickerRouteSpec,
  type PickerRow,
  type PickerValue,
  type RouteGroup,
  type PickerTarget,
  routeUnsupported,
  rowWarning,
} from '@/lib/model-picker';
import { VendorMark } from './VendorMark';

interface BaseProps {
  tier: CatalogTier;
  routes: readonly PickerRouteSpec[];
  models: readonly PickerModelInput[];
  loading?: boolean;
  disabled?: boolean;
  'aria-label': string;
  /** data-testid on the trigger. Default `model-picker-trigger`. */
  testId?: string;
  /** Replace the trigger's classes (a text button such as "+ Add model"). */
  triggerClassName?: string;
  /** Replace the trigger's content. */
  triggerLabel?: ReactNode;
  /** What the pick will run: routes that can't serve it are disabled, and OpenAI models warn. */
  target?: PickerTarget;
  /** Badge text for current rows. Default "current". */
  currentLabel?: string;
  className?: string;
}

interface SingleProps extends BaseProps {
  mode?: 'single';
  value: PickerValue | null;
  onChange: (value: PickerValue) => void;
}

interface MultiProps extends BaseProps {
  mode: 'multi';
  /** Chosen rows, highest priority first. Excludes `locked`. */
  value: readonly PickerValue[];
  onChange: (value: PickerValue[]) => void;
  /** Total rows allowed, locked included. */
  max: number;
  /** Rows already in (a pool's arms): shown checked, never toggled. */
  locked?: readonly PickerValue[];
  /** Confirm button text for n new rows. */
  confirmLabel?: (n: number) => string;
}

export type CatalogModelPickerProps = SingleProps | MultiProps;

type Item =
  | { kind: 'row'; row: PickerRow }
  | { kind: 'more'; id: string; vendor: string; count: number };

const BADGE_TEXT: Record<Badge, string> = { current: 'current', recommended: 'recommended', cheapest: 'cheapest', newest: 'newest' };

function bandText(tier: CatalogTier): string {
  const b = TIER_PRICE_BANDS[tier];
  return b.minInput === 0 ? `< ${formatPrice(b.maxInput)}` : `${formatPrice(b.minInput)}–${formatPrice(b.maxInput)}`;
}

function BadgeChip({ badge, label }: { badge: Badge; label: string }) {
  const tone = badge === 'recommended'
    ? 'border-accent text-accent-text'
    : badge === 'current'
      ? 'border-text-primary bg-text-primary text-surface-1'
      : badge === 'cheapest'
        ? 'border-status-success/60 text-status-success'
        : 'border-border-default text-text-muted';
  return (
    <span data-badge={badge} className={`inline-block border px-1 py-px text-[11px] md:text-[9.5px] font-semibold uppercase leading-[1.35] tracking-[0.8px] ${tone}`}>
      {label}
    </span>
  );
}

function Price({ row }: { row: PickerRow }) {
  if (row.inputPrice === undefined) return <span className="text-text-muted">–</span>;
  return (
    <span className="tabular-nums">
      <span className="text-text-primary">{formatPrice(row.inputPrice)}</span>
      <span className="text-text-muted">/{formatPrice(row.outputPrice)}</span>
    </span>
  );
}

export function CatalogModelPicker(props: CatalogModelPickerProps) {
  const {
    tier, routes, models, target, loading = false, disabled = false, 'aria-label': ariaLabel, testId = 'model-picker-trigger',
    triggerClassName, triggerLabel, currentLabel = 'current', className = '',
  } = props;
  const multi = props.mode === 'multi';
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [band, setBand] = useState<'fits' | 'all'>('fits');
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [draft, setDraft] = useState<PickerValue[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-models`;

  const lockedProp = multi ? (props as MultiProps).locked : undefined;
  const single = !multi ? (props as SingleProps).value : null;
  // Keyed by content so an inline array from the caller does not rebuild every row on each render.
  const currentKey = JSON.stringify(multi ? lockedProp ?? [] : single ? [single] : []);
  const current = useMemo<PickerValue[]>(() => JSON.parse(currentKey), [currentKey]);
  const locked = multi ? current : [];

  const rows = useMemo(() => buildPickerRows(models, routes, tier, current), [models, routes, tier, current]);
  const draftKeys = useMemo(() => new Set(draft.map(pickerKey)), [draft]);
  const lockedKeys = useMemo(() => new Set(rows.filter((r) => r.badges.includes('current')).map((r) => r.key)), [rows]);
  const groups = useMemo(
    () => groupPickerRows(rows, routes, { query, band, showHidden, expanded, pinned: draftKeys }),
    [rows, routes, query, band, showHidden, expanded, draftKeys],
  );
  const items = useMemo<Item[]>(() => groups.flatMap((g) => g.vendors.flatMap((v) => [
    ...v.rows.map((row) => ({ kind: 'row' as const, row })),
    ...(v.more > 0 ? [{ kind: 'more' as const, id: v.id, vendor: v.vendor, count: v.more }] : []),
  ])), [groups]);

  const baseline = useMemo(() => rows.find((r) => r.badges.includes('current')) ?? null, [rows]);
  const selectedRow = single ? rows.find((r) => r.badges.includes('current') && r.route === single.route) ?? null : null;
  const max = multi ? (props as MultiProps).max : 1;
  const full = multi && locked.length + draft.length >= max;

  const openPicker = useCallback(() => {
    if (disabled) return;
    setQuery('');
    setBand('fits');
    setShowHidden(false);
    setExpanded(new Set());
    setDraft(multi ? [...(props as MultiProps).value] : []);
    setOpen(true);
  }, [disabled, multi, props]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus && !isMobile) triggerRef.current?.focus({ preventScroll: true });
  }, [isMobile]);

  // Highlight the current row (or the first) whenever the visible list changes shape.
  useEffect(() => {
    if (!open) return;
    const cur = items.findIndex((it) => it.kind === 'row' && it.row.badges.includes('current'));
    setActive(items.length === 0 ? -1 : !query && cur >= 0 ? cur : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, band, showHidden]);

  useEffect(() => {
    if (open && !isMobile) searchRef.current?.focus({ preventScroll: true });
  }, [open, isMobile]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${listId}-i${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  function toggle(row: PickerRow) {
    if (lockedKeys.has(row.key)) return;
    const v = { route: row.route, model: row.model };
    setDraft((d) => (d.some((x) => pickerKey(x) === row.key) ? d.filter((x) => pickerKey(x) !== row.key) : full ? d : [...d, v]));
  }

  function activate(i: number) {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'more') {
      setExpanded((s) => new Set(s).add(it.id));
      return;
    }
    const spec = routes.find((r) => r.id === it.row.route);
    if (spec && routeUnsupported(spec, target) && !it.row.badges.includes('current')) return;
    if (multi) { toggle(it.row); return; }
    const sp = props as SingleProps;
    if (!sp.value || pickerKey(sp.value) !== it.row.key) sp.onChange({ route: it.row.route, model: it.row.model });
    close();
  }

  function confirmDraft() {
    (props as MultiProps).onChange(draft);
    close();
  }

  function move(d: PickerValue[], i: number, delta: number): PickerValue[] {
    const j = i + delta;
    if (j < 0 || j >= d.length) return d;
    const next = [...d];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  function onKey(e: KeyboardEvent<HTMLElement>) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((i) => Math.max(0, i - 1)); break;
      case 'PageDown': e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 8)); break;
      case 'PageUp': e.preventDefault(); setActive((i) => Math.max(0, i - 8)); break;
      case 'Enter':
        e.preventDefault();
        if (multi && (e.metaKey || e.ctrlKey)) confirmDraft(); else activate(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (query) setQuery(''); else close();
        break;
    }
  }

  const activeItem = items[active];
  const activeRow = activeItem?.kind === 'row' ? activeItem.row : null;
  const itemIndex = new Map<string, number>();
  items.forEach((it, i) => itemIndex.set(it.kind === 'row' ? it.row.key : `more:${it.id}`, i));

  // ── trigger ────────────────────────────────────────────────────────────────
  const triggerContent = triggerLabel ?? (selectedRow ? (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <VendorMark vendor={selectedRow.vendor} />
      <span className="min-w-0 truncate text-text-primary">{selectedRow.model}</span>
      <span className="hidden sm:inline shrink-0 text-[11px] text-text-muted">{routes.find((r) => r.id === selectedRow.route)?.label ?? selectedRow.route}</span>
      <span className="ml-auto hidden sm:inline shrink-0 text-[11px]"><Price row={selectedRow} /></span>
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate text-text-muted">{loading ? 'Loading…' : single ? single.model : 'Choose a model'}</span>
  ));

  const chevron = !triggerClassName && (
    <svg className={`h-3 w-3 shrink-0 text-text-muted transition-transform duration-100 ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="square" d="M2.5 4.5L6 8l3.5-3.5" />
    </svg>
  );

  // ── panel ──────────────────────────────────────────────────────────────────
  const title = ariaLabel;
  const activeId = open && active >= 0 && items[active] ? `${listId}-i${active}` : undefined;

  const toolbar = (
    <div className="shrink-0 space-y-2 border-b-2 border-border-strong p-2">
      <input
        ref={searchRef}
        type="text"
        role="combobox"
        aria-expanded
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label={`Search ${title}`}
        data-testid="model-picker-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder="Search models or vendors"
        spellCheck={false}
        autoComplete="off"
        className={`w-full bg-surface-1 px-2 font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary ${isMobile ? 'h-11 text-base' : 'h-8 text-xs'}`}
      />
      <div className="flex flex-wrap items-center gap-2 text-[12px] md:text-[11px]">
        <div className="inline-flex border-2 border-border-strong" role="group" aria-label="Price filter">
          <button type="button" aria-pressed={band === 'fits'} data-testid="model-picker-band-fits" onClick={() => setBand('fits')}
            className={`min-h-9 md:min-h-7 px-2 font-mono ${band === 'fits' ? 'bg-text-primary text-surface-1' : 'text-text-secondary hover:bg-surface-3'}`}>
            Fits {tier} · {bandText(tier)}
          </button>
          <button type="button" aria-pressed={band === 'all'} data-testid="model-picker-band-all" onClick={() => setBand('all')}
            className={`min-h-9 md:min-h-7 border-l-2 border-border-strong px-2 font-mono ${band === 'all' ? 'bg-text-primary text-surface-1' : 'text-text-secondary hover:bg-surface-3'}`}>
            All prices
          </button>
        </div>
        <button type="button" aria-pressed={showHidden} data-testid="model-picker-hidden-toggle" onClick={() => setShowHidden((v) => !v)}
          className="inline-flex min-h-9 md:min-h-7 items-center gap-1.5 px-1 font-mono text-text-secondary hover:text-text-primary">
          <span aria-hidden="true" className={`grid h-3.5 w-3.5 place-items-center border-[1.5px] ${showHidden ? 'border-primary bg-primary' : 'border-border-strong'}`}>
            {showHidden && <span className="h-1.5 w-1.5 bg-[var(--on-accent)]" />}
          </span>
          Older and previews
        </button>
        <span className="ml-auto hidden md:inline text-text-muted">$ in/out per MTok · context</span>
      </div>
    </div>
  );

  const draftStrip = multi && (locked.length > 0 || draft.length > 0) && (
    <ol className="shrink-0 border-b border-border-default px-2 py-1.5 space-y-1" aria-label="Chosen, in priority order" data-testid="model-picker-draft">
      {locked.map((v, i) => (
        <li key={pickerKey(v)} className="flex items-center gap-2 font-mono text-[12px] text-text-muted">
          <span className="w-4 text-right tabular-nums">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate">{v.model}</span>
          <span className="text-[11px] uppercase tracking-[1px]">{currentLabel}</span>
        </li>
      ))}
      {draft.map((v, i) => (
        <li key={pickerKey(v)} className="flex items-center gap-2 font-mono text-[12px] text-text-primary" data-testid="model-picker-draft-item">
          <span className="w-4 text-right tabular-nums text-accent-text">{locked.length + i + 1}</span>
          <span className="min-w-0 flex-1 truncate">{v.model}</span>
          <button type="button" aria-label={`Move ${v.model} up`} disabled={i === 0} onClick={() => setDraft((d) => move(d, i, -1))}
            className="grid h-8 w-8 md:h-6 md:w-6 place-items-center border border-border-default disabled:opacity-30 hover:bg-surface-3">↑</button>
          <button type="button" aria-label={`Move ${v.model} down`} disabled={i === draft.length - 1} onClick={() => setDraft((d) => move(d, i, 1))}
            className="grid h-8 w-8 md:h-6 md:w-6 place-items-center border border-border-default disabled:opacity-30 hover:bg-surface-3">↓</button>
          <button type="button" aria-label={`Remove ${v.model}`} onClick={() => setDraft((d) => d.filter((_, k) => k !== i))}
            className="grid h-8 w-8 md:h-6 md:w-6 place-items-center border border-border-default hover:bg-surface-3 hover:text-status-error">×</button>
        </li>
      ))}
    </ol>
  );

  const routeById = new Map(routes.map((r) => [r.id, r]));

  function renderRow(row: PickerRow) {
    const i = itemIndex.get(row.key)!;
    const isActive = i === active;
    const isLocked = multi && lockedKeys.has(row.key);
    const checked = multi ? isLocked || draftKeys.has(row.key) : row.badges.includes('current');
    const unsupported = routeUnsupported(routeById.get(row.route) ?? { id: row.route, catalog: 'anthropic' }, target);
    const warning = rowWarning(row, routeById.get(row.route) ?? { id: row.route, catalog: 'anthropic' }, target);
    const blocked = (multi && !checked && full) || (!!unsupported && !checked);
    return (
      <div
        key={row.key}
        id={`${listId}-i${i}`}
        role="option"
        aria-selected={checked}
        aria-disabled={isLocked || blocked || undefined}
        title={unsupported ?? undefined}
        data-key={row.key}
        data-testid="model-picker-row"
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => { if (!isActive) setActive(i); }}
        onClick={() => { if (!isLocked && !blocked) activate(i); }}
        className={`relative cursor-pointer select-none border-l-[3px] px-2 ${isMobile ? 'py-2.5' : 'py-1.5'} ${
          isActive ? 'border-l-primary bg-surface-3' : 'border-l-transparent'
        } ${isLocked || blocked ? 'cursor-default' : ''} ${blocked ? 'opacity-45' : ''}`}
      >
        <div className={`grid items-center gap-x-2 ${isMobile ? 'grid-cols-[20px_minmax(0,1fr)_20px]' : 'grid-cols-[18px_minmax(0,1fr)_auto_72px_40px_16px]'}`}>
          <VendorMark vendor={row.vendor} />
          <span className="min-w-0">
            <span className={`block truncate font-mono ${isMobile ? 'text-[14px]' : 'text-[12.5px]'} ${checked ? 'font-semibold text-text-primary' : 'text-text-primary'}`}>
              {row.route.includes('openrouter') || row.model.includes('/') ? row.short : row.model}
            </span>
            {!row.listed && <span className="block text-[11px] text-status-warning">not in the catalog</span>}
            {warning && <span className="block text-[11px] text-status-warning" data-testid="model-picker-warning">{warning}</span>}
            {row.hidden && row.listed && showHidden && <span className="block text-[11px] text-text-muted">{row.hidden}</span>}
          </span>
          {!isMobile && (
            <>
              <span className="flex items-center gap-1">
                {row.badges.map((b) => <BadgeChip key={b} badge={b} label={b === 'current' ? currentLabel : BADGE_TEXT[b]} />)}
                {band === 'all' && row.band !== 'in' && row.band !== 'unknown' && (
                  <span className="text-[11px] md:text-[9.5px] uppercase tracking-[0.8px] text-text-muted">{row.band} band</span>
                )}
              </span>
              <span className="text-right font-mono text-[11.5px]"><Price row={row} /></span>
              <span className="text-right font-mono text-[11.5px] tabular-nums text-text-muted">{formatContext(row.contextLength)}</span>
            </>
          )}
          <span className="flex justify-end">
            {multi ? (
              <span aria-hidden="true" className={`grid h-4 w-4 place-items-center border-[1.5px] ${checked ? (isLocked ? 'border-text-muted bg-text-muted' : 'border-primary bg-primary') : 'border-border-strong'}`}>
                {checked && <svg className="h-3 w-3 text-surface-1" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={3}><path strokeLinecap="square" d="M3 8.5l3.2 3L13 4.5" /></svg>}
              </span>
            ) : checked ? (
              <svg className="h-3.5 w-3.5 text-accent-text" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="square" d="M3 8.5l3.2 3L13 4.5" /></svg>
            ) : null}
          </span>
        </div>
        {isMobile && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-7 font-mono text-[12px]">
            {row.badges.map((b) => <BadgeChip key={b} badge={b} label={b === 'current' ? currentLabel : BADGE_TEXT[b]} />)}
            <Price row={row} />
            <span className="text-text-muted">{formatContext(row.contextLength)}</span>
          </div>
        )}
      </div>
    );
  }

  function renderGroup(g: RouteGroup, gi: number) {
    const hid = `${listId}-g${gi}`;
    const showVendors = g.route.catalog === 'openrouter';
    return (
      <div key={g.route.id} role="group" aria-labelledby={hid} data-route={g.route.id} className="border-t-2 border-border-strong first:border-t-0">
        <div id={hid} role="presentation" className="sticky top-0 z-[2] flex items-baseline gap-2 bg-surface-2 px-2.5 pb-1 pt-2">
          <span className="font-mono text-[12px] md:text-[11px] font-bold uppercase tracking-[1.5px] text-text-primary">{g.route.label}</span>
          {g.route.note && <span className="hidden sm:inline truncate text-[11px] text-text-muted">{g.route.note}</span>}
          <span className="ml-auto shrink-0 text-[11px]">
            {g.route.key === 'set' && <span className="text-status-success">● key set</span>}
            {g.route.key === 'missing' && (
              <Link href="/app/settings/providers" className="text-status-warning underline hover:no-underline">no key · add</Link>
            )}
          </span>
        </div>
        {g.vendors.length === 0 && (
          <div role="presentation" className="px-3 py-2 text-[12px] text-text-muted">
            {g.filtered > 0 ? 'Nothing in this price band.' : 'No models.'}
          </div>
        )}
        {g.vendors.map((v) => (
          <div key={v.id} role="presentation">
            {showVendors && (
              <div role="presentation" className="flex items-center gap-2 px-2.5 pb-0.5 pt-1.5 text-[11px] md:text-[10px] font-semibold uppercase tracking-[1.2px] text-text-muted">
                <VendorMark vendor={v.vendor} />
                {vendorLabel(v.vendor)}
              </div>
            )}
            {v.rows.map(renderRow)}
            {v.more > 0 && (() => {
              const i = itemIndex.get(`more:${v.id}`)!;
              return (
                <div
                  id={`${listId}-i${i}`}
                  role="option"
                  aria-selected={false}
                  data-testid="model-picker-more"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => { if (i !== active) setActive(i); }}
                  onClick={() => activate(i)}
                  className={`cursor-pointer border-l-[3px] px-2 py-1.5 pl-8 font-mono text-[12px] md:text-[11.5px] text-accent-text ${i === active ? 'border-l-primary bg-surface-3' : 'border-l-transparent'}`}
                >
                  + {v.more} more{showVendors ? ` ${vendorLabel(v.vendor)}` : ''}
                </div>
              );
            })()}
          </div>
        ))}
        {!query && band === 'fits' && g.filtered > 0 && (
          <button type="button" onClick={() => setBand('all')} className="block w-full px-3 py-1.5 text-left font-mono text-[11px] text-text-muted hover:text-text-primary">
            {g.filtered} more at other prices
          </button>
        )}
      </div>
    );
  }

  const compareBase = multi ? (locked.length ? rows.find((r) => r.key === pickerKey(locked[0])) ?? null : null) : baseline;
  const compare = activeRow && (
    <div className="shrink-0 border-t-2 border-border-strong bg-surface-1 px-2.5 py-1.5 font-mono text-[11.5px]" data-testid="model-picker-compare" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="min-w-0 truncate font-semibold text-text-primary">{activeRow.displayName}</span>
        {compareBase && compareBase.key !== activeRow.key && <span className="text-text-muted">vs {compareBase.short}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {compareRows(activeRow, compareBase).map((c) => (
          <span key={c.label} className="tabular-nums">
            <span className="text-text-muted">{c.label} </span>
            <span className="text-text-primary">{c.value}</span>
            {c.delta && c.delta !== '=' && (
              <span className={c.better === null ? 'text-text-muted' : c.better ? 'text-status-success' : 'text-status-error'}> {c.delta}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );

  const footer = multi && (
    <div className="flex shrink-0 items-center gap-2 border-t border-border-default px-2.5 py-2">
      <span className="font-mono text-[12px] text-text-muted tabular-nums" data-testid="model-picker-count">{locked.length + draft.length}/{max}</span>
      {full && <span className="font-mono text-[11px] text-text-muted">pool is full</span>}
      <span className="flex-1" />
      <button type="button" className="btn h-9 md:h-8" onClick={() => close()}>Cancel</button>
      <button type="button" className="btn btn-primary h-9 md:h-8" disabled={draft.length === 0} onClick={confirmDraft} data-testid="model-picker-confirm">
        {(props as MultiProps).confirmLabel?.(draft.length) ?? (draft.length ? `Add ${draft.length} model${draft.length === 1 ? '' : 's'}` : 'Add models')}
      </button>
    </div>
  );

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        data-value={single ? pickerKey(single) : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openPicker(); } }}
        className={triggerClassName ?? `${triggerClasses('md', open, disabled)} gap-2`}
      >
        {triggerContent}
        {chevron}
      </button>

      <AnchoredPopover
        open={open}
        onClose={() => close(false)}
        anchorRef={triggerRef}
        sheet={isMobile}
        tallSheet
        title={title}
        minWidth={620}
        maxHeight={600}
        align="end"
        testId="model-picker-panel"
      >
        {toolbar}
        {draftStrip}
        <div
          id={listId}
          role="listbox"
          aria-label={title}
          aria-multiselectable={multi || undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {loading && rows.length === 0 && <div className="px-3 py-3 font-mono text-[12px] text-text-muted">Loading the catalog…</div>}
          {!loading && items.length === 0 && (
            <div className="px-3 py-3 font-mono text-[12px] text-text-muted" role="presentation">
              {query ? `No model matches “${query}”.` : 'No models in this band. Try All prices.'}
            </div>
          )}
          {groups.map(renderGroup)}
        </div>
        {compare}
        {footer}
      </AnchoredPopover>
    </div>
  );
}
