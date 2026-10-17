import type { FleetRunner } from '@buildd/shared';

/**
 * A runner's count in words, the one every runner surface prints: "2 of 3
 * busy", "6 running, over its 5 slots" when it runs more than it now
 * advertises (slots lowered while agents ran), or "Offline".
 */
export function runnerBusyLine(runner: Pick<FleetRunner, 'online' | 'maxSlots' | 'slots'>): string {
  if (!runner.online) return 'Offline';
  const busy = runner.slots.filter(s => s.worker).length;
  if (busy > runner.maxSlots) return `${busy} running, over its ${runner.maxSlots} slot${runner.maxSlots === 1 ? '' : 's'}`;
  return `${busy} of ${runner.maxSlots} busy`;
}
