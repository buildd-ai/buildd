import { runnerUpdateLine, type FleetRunner } from '@buildd/shared';

/** "01:23 UTC" for the update lines: a time of day, read next to "since". */
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * A runner's count in words, the one every runner surface prints: "2 of 3
 * busy", "6 running, over its 5 slots" when it runs more than it now
 * advertises (slots lowered while agents ran), or "Offline". While it applies
 * a self-update: "Updating to <version> · Paused for update: …", never free
 * slots, or "Update stuck on <runner> since <time>" once it has gone quiet
 * (spec 47c97f48, R-5 to R-7), which wins over "Offline".
 */
export function runnerBusyLine(runner: Pick<FleetRunner, 'online' | 'maxSlots' | 'slots'> & Partial<Pick<FleetRunner, 'update' | 'name'>>): string {
  const update = runner.update ?? null;
  if (update?.stuck) return runnerUpdateLine(update, runner.name ?? 'this runner', clock);
  if (!runner.online) return 'Offline';
  if (update) return runnerUpdateLine(update, runner.name ?? 'this runner', clock);
  const busy = runner.slots.filter(s => s.worker).length;
  if (busy > runner.maxSlots) return `${busy} running, over its ${runner.maxSlots} slot${runner.maxSlots === 1 ? '' : 's'}`;
  return `${busy} of ${runner.maxSlots} busy`;
}
