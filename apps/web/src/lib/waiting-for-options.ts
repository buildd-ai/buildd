/**
 * The labels of a parked question's options, whatever shape the row holds.
 * The runner writes option objects ({ label, consequence, recommended });
 * older rows hold plain strings. Every surface that wants plain labels reads
 * them through here (guarded by waiting-for-options-guard.test.ts).
 */
export function waitingForOptionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const o of options) {
    const label = typeof o === 'string' ? o : (o && typeof o === 'object' ? (o as { label?: unknown }).label : undefined);
    if (typeof label === 'string' && label.trim()) out.push(label);
  }
  return out;
}
