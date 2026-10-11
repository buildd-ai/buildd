/**
 * Runs the `mission_strand_choice` decision for the stranded cards a page
 * rendered (lib/strand-choice-decision.ts), from the rows the page already
 * loaded.
 *
 * In `shadow` mode it runs after the response, so it can never slow or
 * fail a render, and the cards keep today's order. In `gated` mode it uses
 * cached picks and schedules misses after the response — button order is the
 * only thing a pick may ever change.
 */
import { after } from 'next/server';
import { cardLocalStrand, type MissionCardRow } from './mission-card-view';
import type { StrandCta } from './mission-list-card';
import {
  STRAND_CHOICE_MODE,
  adviseStrandChoice,
  strandButtonOrder,
  strandChoiceFacts,
  peekStrandChoiceCache,
  type StrandChoiceDeps,
} from './strand-choice-decision';

export interface StrandCard {
  row: MissionCardRow & { teamId?: string | null };
  strand: StrandCta;
}

type Schedule = (fn: () => Promise<unknown>) => void;

export async function applyStrandChoice(
  cards: readonly StrandCard[],
  opts: { now: number; accountId?: string | null; userId?: string | null; schedule?: Schedule; deps?: StrandChoiceDeps; mode?: 'shadow' | 'gated' },
): Promise<void> {
  const mode = opts.mode ?? STRAND_CHOICE_MODE;
  const looks = cards.flatMap(c => {
    const strand = cardLocalStrand(c.row, opts.now);
    if (!strand?.stranded || !c.row.teamId) return [];
    const facts = strandChoiceFacts({
      missionId: c.row.id,
      teamId: c.row.teamId,
      workspaceId: c.row.workspaceId ?? null,
      executor: c.row.executor ?? 'local',
      strand: { ...strand, flipBlockedReason: c.strand.blockedReason },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tasks: (c.row.tasks ?? []) as any,
      now: opts.now,
    });
    return [{ card: c, facts: { ...facts, accountId: opts.accountId ?? null, userId: opts.userId ?? null } }];
  });
  if (looks.length === 0) return;

  if (mode === 'shadow') {
    const run = () => Promise.all(looks.map(l => adviseStrandChoice(l.facts, opts.deps)));
    try {
      (opts.schedule ?? after)(run);
    } catch {
      void run();
    }
    return;
  }

  // Gated mode: peek cache for each card. Render fallback order now, schedule API calls for misses.
  const picks = looks.map(l => {
    const hit = peekStrandChoiceCache(l.facts, opts.deps?.cache);
    if (hit) return hit; // Cache hit; use immediately
    // Cache miss; schedule the call in the background via after() or provided scheduler
    try {
      (opts.schedule ?? after)(() => adviseStrandChoice(l.facts, opts.deps));
    } catch {
      void adviseStrandChoice(l.facts, opts.deps);
    }
    return null; // Render fallback order now
  });
  looks.forEach((l, i) => { l.card.strand.order = strandButtonOrder(picks[i], 'gated'); });
}
