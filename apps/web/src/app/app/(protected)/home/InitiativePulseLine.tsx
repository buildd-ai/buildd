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
      className="group inline-flex items-baseline gap-1.5 mb-8 md:mb-10 text-[13px] text-text-secondary hover:text-text-primary transition-colors"
    >
      {/* One string, so the clause set can never be split by a wrapper. */}
      <span>{line.text}</span>
      <span aria-hidden="true" className="text-text-muted group-hover:text-text-primary transition-colors">
        →
      </span>
    </Link>
  );
}
