/**
 * Probe for `buildd-home-guard.test.ts` — NOT a test file.
 *
 * Spawned as a child process with the parent's BUILDD_HOME removed and HOME
 * pointed at a throwaway directory, so any store write that falls through to
 * `$HOME/.buildd` lands somewhere the parent can inspect. Exercises the write
 * path of every runner module that persists under BUILDD_HOME, and prints one
 * line per module saying whether the store refused.
 */
import { sessionLog, claimLog } from '../../src/session-logger';
import { saveWorker } from '../../src/worker-store';
import { archiveSession, initHistory } from '../../src/history-store';
import { Outbox } from '../../src/outbox';

function attempt(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`${name}:wrote`);
  } catch (err) {
    console.log(`${name}:refused:${err instanceof Error ? err.name : 'unknown'}`);
  }
}

const worker = {
  id: 'probe-worker',
  taskId: 'probe-task',
  taskTitle: 'probe',
  status: 'done',
  lastActivity: Date.now(),
  milestones: [],
  output: [],
  toolCalls: [],
  messages: [],
} as any;

// Loggers swallow their own errors by design, so the parent judges them by
// the filesystem, not by this line.
attempt('session-logger', () => {
  sessionLog('probe-worker', 'info', 'probe');
  claimLog({ event: 'claim_attempt', slotsRequested: 1, workersClaimed: 0 });
});
attempt('worker-store', () => saveWorker(worker));
attempt('history-store', () => {
  initHistory();
  archiveSession(worker);
});
attempt('outbox', () => {
  // `save` is private; call it directly so the probe does not depend on which
  // endpoints `shouldQueue` currently accepts.
  (new Outbox() as any).save();
});
