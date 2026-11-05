import Chip from '@/components/ui/Chip';
import type { ShippedStanding } from '@/lib/specs/matches-shipped';

const STATE_WORDS = { failed: 'failed', no_check: 'has no check' } as const;

/**
 * What the merged work shows for a waiting revision (Living Spec b7fc9316
 * R-34, AC-35). Every head criterion passed at the merged commit: the label
 * "Matches what shipped", nothing listed. Otherwise only the criteria that
 * failed or have no check are named, and no label. Information only: it never
 * approves, and a revision it labels still waits on a person.
 */
export default function SpecShippedLine({ shipped }: { shipped: ShippedStanding | null }) {
  if (!shipped || !shipped.merged) return null;
  if (shipped.matches) return <div><Chip tone="success" data-testid="spec-shipped-label">Matches what shipped</Chip></div>;
  if (!shipped.unmet.length) return null;
  return (
    <p className="text-meta text-text-secondary [overflow-wrap:anywhere]" data-testid="spec-shipped-unmet">
      Shipped work does not yet cover:{' '}
      {shipped.unmet.map((u, i) => (
        <span key={u.id}>{i ? ', ' : ''}<span className="font-mono">{u.id}</span> {STATE_WORDS[u.state]}</span>
      ))}
    </p>
  );
}
