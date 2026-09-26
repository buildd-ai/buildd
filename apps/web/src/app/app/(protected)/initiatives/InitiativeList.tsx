'use client';

import { useState } from 'react';
import { InitiativeCard } from '@/components/initiatives/InitiativeCard';
import type { InitiativeGroup } from '@/lib/initiative-view';

/**
 * The Initiatives list: one card per initiative, grouped by what you act on
 * first (lib/initiative-view.ts `groupInitiativeCards`). Completed initiatives
 * collapse behind one control at the bottom.
 */
export function InitiativeList({ groups }: { groups: InitiativeGroup[] }) {
  const [showCompleted, setShowCompleted] = useState(false);
  return (
    <div className="flex flex-col gap-7">
      {groups.map((g) => {
        const collapsed = g.section === 'completed' && !showCompleted;
        return (
          <section key={g.section} data-testid="initiative-group" data-section={g.section}>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h2 className="section-label text-text-muted">
                {g.label} <span className="text-text-secondary">{g.cards.length}</span>
              </h2>
              {g.section === 'completed' && (
                <button
                  type="button"
                  data-testid="initiative-completed-toggle"
                  onClick={() => setShowCompleted((v) => !v)}
                  className="min-h-11 font-mono text-[12px] text-text-muted hover:text-text-secondary md:min-h-0"
                >
                  {showCompleted ? 'Hide' : `Show ${g.cards.length}`}
                </button>
              )}
            </div>
            {!collapsed && (
              <div className="flex flex-col gap-4">
                {g.cards.map((c) => <InitiativeCard key={c.id} card={c} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
