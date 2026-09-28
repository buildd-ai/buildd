/**
 * Heartbeat-triage experiment readout: the pure half. Rows come from
 * `./heartbeat-triage-readout-source.ts`.
 *
 * Per arm, over missions:
 *   - **Primary:** organizer dispatches per mission. Treatment should be lower.
 *   - **Guardrail, wrong waits:** of the skips followed by a dispatch on the
 *     same mission, how often that next organizer acted (filed, retried or
 *     completed work). A skip whose successor acts may have delayed that work
 *     by a cycle.
 *   - **Gold (both arms):** on dispatched cycles, how often a confident `wait`
 *     pick agreed with the organizer doing nothing. The control arm is pure
 *     shadow, so this is the threshold's precision measured on the exact state
 *     the pick saw.
 *
 * "Acted" is read from rows the cycle wrote (children, retries, a completion
 * proposal), never from the organizer's own status line, which says
 * `action_taken` for cycles that only assessed.
 */

export interface TriageLookRow {
  missionId: string;
  arm: 'control' | 'treatment' | null;
  taskId: string | null;
  pick: 'wait' | 'act' | null;
  confidence: number | null;
  skipped: boolean;
  createdAt: Date;
}

/** What the organizer task a look dispatched went on to do. */
export interface OrganizerOutcome {
  acted: boolean;
  costUsd: number | null;
}

export interface TriageArmReadout {
  missions: number;
  cycles: number;
  dispatched: number;
  skipped: number;
  dispatchesPerMission: number | null;
  organizerCostUsd: number;
  /** Skips followed by a dispatch on the same mission. */
  skipsWithSuccessor: number;
  /** Of those, the successor organizer acted. Lower is better. */
  actedAfterSkipRate: number | null;
  /** Dispatched cycles whose pick was a confident wait. */
  confidentWaitsDispatched: number;
  /** Of those, the organizer did nothing (the pick was right). */
  confidentWaitPrecision: number | null;
}

export type TriageReadoutStatus = 'no_scope' | 'no_baseline' | 'underpowered' | 'ready';

export interface HeartbeatTriageReadout {
  status: TriageReadoutStatus;
  minSamplePerArm: number;
  waitMinConfidence: number;
  arms: { control: TriageArmReadout; treatment: TriageArmReadout };
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

function armReadout(looks: TriageLookRow[], outcomes: ReadonlyMap<string, OrganizerOutcome>, waitMin: number): TriageArmReadout {
  const byMission = new Map<string, TriageLookRow[]>();
  for (const l of looks) {
    const list = byMission.get(l.missionId) ?? [];
    list.push(l);
    byMission.set(l.missionId, list);
  }
  let dispatched = 0, skipped = 0, cost = 0, withSuccessor = 0, actedAfter = 0, confident = 0, confidentRight = 0;
  for (const list of byMission.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    list.forEach((l, i) => {
      if (l.skipped) {
        skipped++;
        const next = list.slice(i + 1).find(n => !n.skipped && n.taskId);
        const o = next?.taskId ? outcomes.get(next.taskId) : undefined;
        if (o) {
          withSuccessor++;
          if (o.acted) actedAfter++;
        }
        return;
      }
      if (!l.taskId) return;
      dispatched++;
      const o = outcomes.get(l.taskId);
      cost += o?.costUsd ?? 0;
      if (o && l.pick === 'wait' && (l.confidence ?? 0) >= waitMin) {
        confident++;
        if (!o.acted) confidentRight++;
      }
    });
  }
  return {
    missions: byMission.size,
    cycles: looks.length,
    dispatched,
    skipped,
    dispatchesPerMission: ratio(dispatched, byMission.size),
    organizerCostUsd: cost,
    skipsWithSuccessor: withSuccessor,
    actedAfterSkipRate: ratio(actedAfter, withSuccessor),
    confidentWaitsDispatched: confident,
    confidentWaitPrecision: ratio(confidentRight, confident),
  };
}

export function computeHeartbeatTriageReadout(
  looks: TriageLookRow[],
  outcomes: ReadonlyMap<string, OrganizerOutcome>,
  opts: { minSamplePerArm: number; waitMinConfidence: number },
): HeartbeatTriageReadout {
  const control = armReadout(looks.filter(l => l.arm === 'control'), outcomes, opts.waitMinConfidence);
  const treatment = armReadout(looks.filter(l => l.arm === 'treatment'), outcomes, opts.waitMinConfidence);
  const status: TriageReadoutStatus =
    control.missions + treatment.missions === 0 ? 'no_scope'
      : control.missions === 0 || treatment.missions === 0 ? 'no_baseline'
        : Math.min(control.missions, treatment.missions) < opts.minSamplePerArm ? 'underpowered'
          : 'ready';
  return { status, minSamplePerArm: opts.minSamplePerArm, waitMinConfidence: opts.waitMinConfidence, arms: { control, treatment } };
}

/** Did the organizer task act? From its rows, not its self-report. */
export function organizerActed(task: { childCount: number; structuredOutput: unknown }): boolean {
  if (task.childCount > 0) return true;
  const so = (task.structuredOutput && typeof task.structuredOutput === 'object') ? task.structuredOutput as Record<string, unknown> : {};
  const retried = Number(so.tasksRetried);
  return (Number.isFinite(retried) && retried > 0) || so.missionComplete === true;
}
