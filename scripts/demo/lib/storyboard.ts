/**
 * Pure storyboard helpers for run-storyboard.ts: named viewports, output file
 * names, and which element targets a step records boxes for.
 */

export type Viewport = { width: number; height: number; scale: number; mobile?: boolean };
export type ViewportSpec = { width?: number; height?: number; scale?: number; mobile?: boolean };

export const DESKTOP = 'desktop';
const DEFAULT_DESKTOP: Viewport = { width: 1440, height: 900, scale: 2 };
/** Built-in phone: iPhone-class 390x844 @3x, touch + mobile UA. Override under `viewports.phone`. */
const DEFAULT_PHONE: Viewport = { width: 390, height: 844, scale: 3, mobile: true };

/** Resolve the board's named viewports. `desktop` comes from the board's top-level `viewport`. */
export function resolveViewports(board: { viewport?: ViewportSpec; viewports?: Record<string, ViewportSpec> }): Record<string, Viewport> {
  const out: Record<string, Viewport> = {
    [DESKTOP]: { ...DEFAULT_DESKTOP, ...stripUndefined(board.viewport ?? {}) },
    phone: { ...DEFAULT_PHONE },
  };
  for (const [name, spec] of Object.entries(board.viewports ?? {})) {
    const base = out[name] ?? (name === DESKTOP ? DEFAULT_DESKTOP : DEFAULT_PHONE);
    out[name] = { ...base, ...stripUndefined(spec) };
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The viewports a step is shot at; unknown names are an error, not a silent skip. */
export function stepViewports(step: { viewports?: string[] }, known: Record<string, Viewport>): string[] {
  const names = step.viewports?.length ? step.viewports : [DESKTOP];
  const bad = names.filter((n) => !known[n]);
  if (bad.length) throw new Error(`[storyboard] unknown viewport(s): ${bad.join(', ')} (known: ${Object.keys(known).join(', ')})`);
  return names;
}

/**
 * How `prepare` scrolls a step's `scrollTo` target into view. `start` (default)
 * puts it at the top edge and backs off `scrollOffset` (120) for sticky headers;
 * `end` puts it at the bottom edge and pushes `scrollOffset` (24) past it, for a
 * target near the end of its scroller (a chat's last card), where scrollTop
 * clamps and "top edge minus an offset" would scroll the wrong way.
 */
export function scrollPlan(step: { scrollAlign?: 'start' | 'end'; scrollOffset?: number }): { block: 'start' | 'end'; delta: number } {
  const block = step.scrollAlign ?? 'start';
  if (block !== 'start' && block !== 'end') throw new Error(`[storyboard] scrollAlign must be start or end, got "${block}"`);
  return block === 'end' ? { block, delta: step.scrollOffset ?? 24 } : { block, delta: 0 - (step.scrollOffset ?? 120) };
}

/** Manifest key + PNG name for one capture. Desktop keeps the legacy `<id>-<theme>` names. */
export function captureKey(viewport: string, theme: string): string {
  return viewport === DESKTOP ? theme : `${viewport}-${theme}`;
}
export function captureFile(stepId: string, viewport: string, theme: string, ext = 'png'): string {
  return `${stepId}-${captureKey(viewport, theme)}.${ext}`;
}

/**
 * Whether a highlight element is actually painted. A non-empty boundingBox is
 * not enough: a closed <details> keeps its content in layout under
 * content-visibility, so the collapsed home fleet would report boxes for slot
 * rows that aren't on screen. Runs in the page (passed to `el.evaluate`), so it
 * must stay self-contained.
 */
export function isRendered(node: { checkVisibility?: (opts?: Record<string, boolean>) => boolean }): boolean {
  if (typeof node.checkVisibility !== 'function') return true;
  return node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: false });
}

/**
 * Targets to record boxes for: the step's own `highlight` (warned when missing)
 * plus the board-wide `highlight` defaults (recorded when present, silent when
 * not — a close-up list shared by every shot).
 */
export function highlightTargets(step: { highlight?: string[] }, boardDefaults: string[] = []): Array<{ target: string; required: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ target: string; required: boolean }> = [];
  for (const target of step.highlight ?? []) if (!seen.has(target)) { seen.add(target); out.push({ target, required: true }); }
  for (const target of boardDefaults) if (!seen.has(target)) { seen.add(target); out.push({ target, required: false }); }
  return out;
}
