/**
 * The projection's summary clause (Living Spec 1b257609 R-6, R-9): words, with
 * every task, mission or spec as a link to its page. Rendered inside a card's
 * existing summary line, never as a block of its own.
 */
import Link from 'next/link';
import type { WaitsPart } from '@buildd/core/question-waits';

export default function WaitsParts({ parts, linkClassName }: { parts: readonly WaitsPart[]; linkClassName?: string }) {
  return (
    <>
      {parts.map((p, i) => (p.href
        ? <Link key={i} href={p.href} className={linkClassName ?? 'text-text-primary underline-offset-4 hover:underline'}>{p.text}</Link>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}
