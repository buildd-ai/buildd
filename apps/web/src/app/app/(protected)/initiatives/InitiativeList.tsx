'use client';

import { InitiativeRow } from '@/components/initiatives/InitiativeCard';
import Disclosure from '@/components/ui/Disclosure';
import Section from '@/components/ui/Section';
import type { InitiativeGroup } from '@/lib/initiative-view';

/**
 * The Initiatives list: one L1 row per initiative, grouped by what you act on
 * first (lib/initiative-view.ts `groupInitiativeCards`). Completed initiatives
 * collapse behind one Disclosure at the bottom, as Missions' Completed does.
 */
export function InitiativeList({ groups }: { groups: InitiativeGroup[] }) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const rows = (
          <div className="border-b border-border-default">
            {g.cards.map((c) => <InitiativeRow key={c.id} card={c} />)}
          </div>
        );
        return (
          <div key={g.section} data-testid="initiative-group" data-section={g.section}>
            {g.section === 'completed' ? (
              <Disclosure summary={g.label} count={g.cards.length}>
                {rows}
              </Disclosure>
            ) : (
              <Section title={g.label} count={g.cards.length} className="py-2">
                {rows}
              </Section>
            )}
          </div>
        );
      })}
    </div>
  );
}
