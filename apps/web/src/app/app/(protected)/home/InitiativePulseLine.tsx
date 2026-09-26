import Link from 'next/link';
import { buildInitiativePulseLine, type PulseLineItem } from '@/lib/initiative-pulse-line';

/** Stable hook for E2E, and for asserting the line actually rendered. */
export const PULSE_LINE_TESTID = 'home-initiative-pulse';

/**
 * Home's one-line initiative pulse — the replacement for `InitiativeRail`
 * (spec §2.1, migration step 5).
 *
 * `Initiatives · 2 losing · 1 stuck →`, or the arc's own title when exactly one
 * contributes. It sits between the greeting block and Waiting on You and renders
 * **at most one line**.
 *
 * When no arc contributes a clause the component returns `null`: absence, not
 * empty chrome. A team that is winning everywhere sees no label, no header and no
 * "nothing to see" text (§2.2, AC-1) — the line exists only to say *no*.
 */
export function InitiativePulseLine({ items }: { items: PulseLineItem[] }) {
  const line = buildInitiativePulseLine(items);
  if (!line) return null;

  return (
    <Link
      href={line.href}
      data-testid={PULSE_LINE_TESTID}
      data-variant="chip"
      className="group inline-flex max-w-full items-center min-h-11 md:min-h-9 gap-2 border border-border-strong bg-surface-2 px-3 font-mono text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
    >
      <i aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-status-warning" />
      {/* One string, so the clause set can never be split by a wrapper. */}
      <span className="min-w-0 truncate">{line.text}</span>
      <span aria-hidden="true" className="text-text-muted group-hover:text-text-primary transition-colors">
        →
      </span>
    </Link>
  );
}
