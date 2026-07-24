export function isDeferredTaskClaimable(startAt: Date | null, now: Date): boolean {
  return startAt === null || startAt <= now;
}
