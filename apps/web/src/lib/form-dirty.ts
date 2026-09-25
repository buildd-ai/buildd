/**
 * Unsaved-changes detection for editor forms.
 *
 * A form is dirty when saving it would send something different from what was
 * last saved. Both sides are reduced to a canonical string and compared:
 *
 * - Object key order is irrelevant; `undefined` keys count as absent.
 * - Arrays are ordered (positional), at any depth — unless their top-level key
 *   is listed in `unordered`, in which case they compare as multisets. Use that
 *   for toggle selections (tools, delegates, connector ids) where re-toggling
 *   appends and the stored order carries no meaning.
 * - Strings compare verbatim. Whitespace-only edits ARE dirty: the editors save
 *   text as typed, so a clean state that hides a trailing newline would leave
 *   the user unable to save what they see.
 *
 * Callers should snapshot the *normalised payload* (e.g. `description || null`,
 * parsed `maxTurns`), not raw input state, so two inputs that save the same
 * value read as clean.
 */

export interface DirtyOptions<K extends PropertyKey = PropertyKey> {
  /** Top-level keys whose array values are compared order-insensitively. */
  unordered?: readonly K[];
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

/** Canonical string for a form's state; equal strings mean equal state. */
export function formSnapshot<T extends object>(state: T, opts: DirtyOptions<keyof T> = {}): string {
  const unordered = new Set<PropertyKey>(opts.unordered ?? []);
  const normalised: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    normalised[k] = unordered.has(k) && Array.isArray(v)
      ? v.map(canonical).sort()
      : v;
  }
  return canonical(normalised);
}

export function isDirty<T extends object>(saved: T, current: T, opts: DirtyOptions<keyof T> = {}): boolean {
  return formSnapshot(saved, opts) !== formSnapshot(current, opts);
}
