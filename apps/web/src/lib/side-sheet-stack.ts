/**
 * The side-sheet stack: which `SideSheet` is showing, and what is under it.
 *
 * Every panel a page opens beside its content (a task, Records, Notes, goal
 * criteria, settings) is one sheet in one place, the right edge (the bottom on
 * a phone). Opening a second one stacks it on top instead of drawing a modal
 * over the first: only the top sheet is visible, it carries a Back control
 * that pops it, and ✕ closes the whole stack. A sheet asked to come forward
 * again (the task sheet stepping to another task) moves to the top.
 *
 * Module-level and framework-free so it is testable without a DOM; the
 * component reads it through `useSyncExternalStore`.
 */

export interface SheetEntry {
  id: string;
  title: string;
  close: () => void;
}

type Listener = () => void;

let stack: readonly SheetEntry[] = [];
const listeners = new Set<Listener>();
const EMPTY: readonly SheetEntry[] = [];

function emit() {
  for (const l of listeners) l();
}

/** Put `entry` on top (moving it there if it is already open). */
export function pushSheet(entry: SheetEntry): void {
  stack = [...stack.filter(e => e.id !== entry.id), entry];
  emit();
}

/** Refresh an open entry's title/close in place, without reordering. */
export function updateSheet(entry: SheetEntry): void {
  if (!stack.some(e => e.id === entry.id)) return;
  stack = stack.map(e => (e.id === entry.id ? entry : e));
  emit();
}

export function removeSheet(id: string): void {
  if (!stack.some(e => e.id === id)) return;
  stack = stack.filter(e => e.id !== id);
  emit();
}

/** ✕: close every open sheet, top first. */
export function closeAllSheets(): void {
  for (const e of [...stack].reverse()) e.close();
}

export function subscribeSheets(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const getSheetStack = (): readonly SheetEntry[] => stack;
export const getServerSheetStack = (): readonly SheetEntry[] => EMPTY;

/**
 * Where `id` sits: `top` when it is the one showing (or not registered yet:
 * a sheet that just opened renders before its effect registers it), and the
 * entry under it, for the Back label.
 */
export function sheetPosition(s: readonly SheetEntry[], id: string): { top: boolean; below: SheetEntry | null } {
  const i = s.findIndex(e => e.id === id);
  if (i === -1) return { top: true, below: s.length ? s[s.length - 1] : null };
  return { top: i === s.length - 1, below: i > 0 ? s[i - 1] : null };
}

/** Test seam. */
export function resetSheetStack(): void {
  stack = [];
  emit();
}
