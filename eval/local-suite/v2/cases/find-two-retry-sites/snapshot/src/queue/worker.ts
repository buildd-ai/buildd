import { nextDelivery, type Job } from './redelivery';

export function startWorker(run: (j: Job) => Promise<void>) {
  const pending: (Job & { at?: number })[] = [];
  return {
    push: (j: Job) => pending.push(j),
    async tick(now: number) {
      const j = pending.shift();
      if (!j) return;
      try {
        await run(j);
      } catch {
        pending.push(nextDelivery(j, now));
      }
    },
  };
}
