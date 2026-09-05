/**
 * Noun agreement for interpolated counts.
 *
 * Several panels gated a line on `count > 0` and then hardcoded the plural
 * noun, so a count of exactly 1 rendered "1 tasks" / "1 runs". Inline
 * ternaries are the existing pattern elsewhere in the app and read fine at
 * one or two call sites, but they are easy to forget at the next one.
 */

/** The noun form matching `count`. Only exactly 1 takes the singular. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  if (count === 1) return singular;
  return pluralForm ?? `${singular}s`;
}

/** `count` joined to its matching noun form, e.g. `countOf(1, 'task')` → "1 task". */
export function countOf(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${plural(count, singular, pluralForm)}`;
}
