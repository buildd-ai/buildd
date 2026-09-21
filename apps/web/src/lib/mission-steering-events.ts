/**
 * Builds the steering-rail input for `computeMissionFlightStrip`
 * (packages/core/mission-helpers.ts) from live mission data. Core does not
 * query — this is the one place that decides what counts as a human touch or
 * an orchestrator cycle that actually ran a model.
 *
 * - Human: a `mission_notes` row a real person authored (`authorType === 'user'`).
 * - Orchestrator: a `mode: 'planning'` task created by the schedule/orchestrator
 *   loop whose worker actually invoked a model (`turns > 0`). A deterministic
 *   heartbeat tick that never called a model has `turns` 0 and must not be fed
 *   in — the rail exists to distinguish "the mission thought" from "a cron
 *   fired and did nothing".
 */
import type { FlightStripSteeringEvent } from '@buildd/core/mission-helpers';

export interface SteeringTaskInput {
  id: string;
  mode?: string | null;
  creationSource?: string | null;
  workers?: Array<{ turns?: number | null; startedAt?: Date | string | null }> | null;
}

export interface SteeringNoteInput {
  id: string;
  authorType: string;
  createdAt: Date | string;
}

const ORCHESTRATOR_CREATION_SOURCES = new Set(['schedule', 'orchestrator']);

export function buildSteeringEvents(
  tasks: readonly SteeringTaskInput[],
  notes: readonly SteeringNoteInput[],
): FlightStripSteeringEvent[] {
  const orchestratorEvents: FlightStripSteeringEvent[] = tasks.flatMap(t => {
    if (t.mode !== 'planning') return [];
    if (!ORCHESTRATOR_CREATION_SOURCES.has(t.creationSource ?? '')) return [];
    const worker = (t.workers ?? []).find(w => (w.turns ?? 0) > 0 && w.startedAt);
    if (!worker) return [];
    return [{ id: t.id, kind: 'orchestrator' as const, at: worker.startedAt! }];
  });

  const humanEvents: FlightStripSteeringEvent[] = notes
    .filter(n => n.authorType === 'user')
    .map(n => ({ id: n.id, kind: 'human' as const, at: n.createdAt }));

  return [...orchestratorEvents, ...humanEvents];
}

/** N in "Orchestrator · N plans, M ticks" — total plan-cycle count (Rule S-2),
 * read off the already-computed rail so the UI never re-derives the cap/cluster logic. */
export function countOrchestratorPlans(rail: { marks: Array<{ kind: 'human' | 'orchestrator'; count: number }> }): number {
  return rail.marks.filter(m => m.kind === 'orchestrator').reduce((sum, m) => sum + m.count, 0);
}
