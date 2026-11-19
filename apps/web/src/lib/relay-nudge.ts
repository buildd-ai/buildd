/**
 * The relay's realtime nudge (docs/specs/local-runner-provider.md §4.4): when a
 * job is queued for a runner, ping its account's runner channel so it claims
 * at once. Ids only, never payload. With Pusher absent this is a no-op and the
 * runner claims on its poll.
 */
import { setRelayNudge } from '@buildd/core/model-relay';
import { channels, events, triggerEvent } from './pusher';

export function registerRelayNudge(): void {
  setRelayNudge(async (runner, job) => {
    await triggerEvent(channels.runner(runner.accountId), events.RELAY_JOB_QUEUED, { runnerId: runner.runnerId, jobId: job.id, kind: job.kind });
  });
}
