'use client';

import Link from 'next/link';

export type ReplacedOption = { id: string; title: string; version: number };
export type ApprovalRetirementReply =
  | { specId: string; title: string; state: 'superseded' }
  | { specId: string; title: string | null; state: 'stale'; reason: string };

/**
 * What a press of Approve says when the revision replaces other specs (R-77):
 * approved, which were retired, and any that changed after the sheet was read
 * and so were left as they are (the approval stands). Pure.
 */
export function approvalResultText(revision: number, retirements: ApprovalRetirementReply[] | undefined): { tone: 'ok' | 'warn'; text: string } {
  const done = (retirements ?? []).filter((r) => r.state === 'superseded').map((r) => r.title);
  const stale = (retirements ?? []).filter((r) => r.state === 'stale');
  const parts = [`Approved revision ${revision}.`];
  if (done.length) parts.push(`Retired ${done.join(', ')}.`);
  for (const s of stale) parts.push(`${s.title ?? 'A replaced spec'} was not retired: it changed after you opened this. Retire it from its own page.`);
  return { tone: stale.length ? 'warn' : 'ok', text: parts.join(' ') };
}

/** The retire choice an approve sends: each checked spec at the version the sheet read. */
export const retireChoice = (options: ReplacedOption[], checked: ReadonlySet<string>) =>
  options.filter((o) => checked.has(o.id)).map((o) => ({ specId: o.id, expectedVersion: o.version }));

/**
 * One line per spec the revision replaces, "Replaces <spec>. Retire it.",
 * checked unless the person unchecks it (R-77). Sits above Approve, in the
 * approval sheet on a phone and the rail on desktop.
 */
export default function SpecReplacedChoice({ options, checked, onToggle }: { options: ReplacedOption[]; checked: ReadonlySet<string>; onToggle: (id: string) => void }) {
  if (!options.length) return null;
  return (
    <ul className="flex flex-col" data-testid="spec-approve-replaced">
      {options.map((o) => (
        <li key={o.id} className="flex items-start gap-2" data-testid="spec-approve-replaced-item" data-spec-id={o.id}>
          <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center md:min-h-8 md:min-w-8">
            <input
              type="checkbox"
              checked={checked.has(o.id)}
              onChange={() => onToggle(o.id)}
              aria-label={`Retire ${o.title}`}
              data-testid="spec-approve-retire"
              className="h-4 w-4 accent-[var(--color-accent,currentColor)]"
            />
          </label>
          <span className="flex min-h-11 flex-1 items-center text-body text-text-secondary [overflow-wrap:anywhere] md:min-h-8">
            <span>
              Replaces <Link href={`/app/specs/${o.id}`} className="text-text-primary underline">{o.title}</Link>. Retire it.
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
