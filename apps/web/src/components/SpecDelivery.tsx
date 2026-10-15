'use client';

import Link from 'next/link';
import Disclosure from '@/components/ui/Disclosure';
import Section from '@/components/ui/Section';
import { criterionWords } from '@/lib/specs/delivery-words';
import type { SpecDelivery as SpecDeliveryData, DeliveryEntry } from '@/lib/specs/delivery';

const TONE = {
  success: 'text-status-success',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-text-muted',
} as const;

/** External evidence opens in a new tab; an app page stays in this one. */
function EvidenceLink({ href, label, target = false }: { href: string; label: string; target?: boolean }) {
  const external = href.startsWith('https://');
  // On its own (not inside a sentence) a link is a tap target: 44px on a phone.
  const cls = `underline hover:text-text-primary${target ? ' inline-flex min-h-11 min-w-11 items-center md:min-h-0 md:min-w-0' : ''}`;
  return external
    ? <a href={href} target="_blank" rel="noreferrer" className={cls}>{label}</a>
    : <Link href={href} className={cls}>{label}</Link>;
}

function Entry({ e }: { e: DeliveryEntry }) {
  return (
    <li className="flex flex-col gap-1 py-3" data-testid="spec-delivery-entry" data-kind={e.kind} data-id={e.id}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-meta text-text-muted">{e.kind === 'mission' ? 'Mission' : 'Task'}</span>
        <Link href={e.href} className="inline-flex min-h-11 items-center text-body font-medium text-text-primary underline [overflow-wrap:anywhere] md:min-h-0" data-testid="spec-delivery-link">
          {e.title}
        </Link>
      </span>
      <span className="text-meta text-text-secondary" data-testid="spec-delivery-delivered">
        {e.deliveredText}
        {e.links.map((l) => <span key={l.href}>{' '}<EvidenceLink href={l.href} label={l.label} /></span>)}
      </span>
      <span className={`text-meta ${TONE[e.standing.tone]}`} data-testid="spec-delivery-standing">{e.standing.text}</span>
      {e.criteria.length ? (
        <Disclosure summary={<span className="text-meta">Criteria on revision {e.builtTo}</span>} count={e.criteria.length}>
          <ul className="flex flex-col gap-1 pt-1" data-testid="spec-delivery-criteria">
            {e.criteria.map((c) => {
              const w = criterionWords(c.mark);
              return (
                <li key={c.criterionId} className="flex flex-col text-meta" data-testid="spec-delivery-criterion">
                  <span className="flex min-w-0 gap-2">
                    <span className="shrink-0 font-mono text-text-muted">{c.criterionId}</span>
                    <span className="min-w-0 truncate text-text-secondary" title={c.text}>{c.text}</span>
                    <span className={`ml-auto shrink-0 ${TONE[w.tone]}`}>{w.label}</span>
                  </span>
                  {c.evidence.length ? (
                    <span className="flex flex-wrap gap-x-3 pl-10 text-text-muted" data-testid="spec-delivery-evidence">
                      {c.evidence.map((l) => <EvidenceLink key={l.href} href={l.href} label={l.label} target />)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Disclosure>
      ) : null}
    </li>
  );
}

/**
 * Delivery and verification (Living Specs Slice 13, R-61): the missions and
 * tasks that answered to this spec, each linking to its page for PRs and
 * evidence. Delivery and the standing of the revision in force are two lines,
 * never one word. Renders nothing without entries (AC-48).
 */
export default function SpecDelivery({ specId, delivery }: { specId: string; delivery: SpecDeliveryData | null | undefined }) {
  if (!delivery || delivery.entries.length === 0) return null;
  return (
    <Section title="Delivery and verification" id="delivery">
      <ol className="flex flex-col divide-y divide-[var(--line-soft)]" data-testid="spec-delivery">
        {delivery.entries.map((e) => <Entry key={`${e.kind}:${e.id}`} e={e} />)}
      </ol>
      {delivery.next ? (
        <Link
          href={`/app/specs/${specId}?delivery=${encodeURIComponent(delivery.next)}#delivery`}
          className="inline-flex min-h-11 items-center text-meta text-text-secondary underline hover:text-text-primary md:min-h-0"
          data-testid="spec-delivery-more"
        >
          Older work
        </Link>
      ) : null}
    </Section>
  );
}
