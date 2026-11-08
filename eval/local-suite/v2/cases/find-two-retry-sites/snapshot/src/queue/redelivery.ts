const REDELIVERY_MS = 30_000;

export interface Job {
  id: string;
  attempts: number;
}

/** Failed jobs go back on the queue, always 30s later. */
export function nextDelivery(job: Job, now: number) {
  return { ...job, attempts: job.attempts + 1, at: now + REDELIVERY_MS };
}
