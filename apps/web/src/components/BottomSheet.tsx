/**
 * Moved to `components/ui/Sheet.tsx` (docs/design/design-system.md §4). This
 * re-export keeps existing importers unchanged; new code imports the primitive.
 */
export { default, lockScroll, nextTrappedFocus, resolveLockTarget } from './ui/Sheet';
export type { SheetProps as BottomSheetProps } from './ui/Sheet';
