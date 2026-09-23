/**
 * Probe for `buildd-home-guard.test.ts` — NOT a test file.
 *
 * Spawned as a child process with the parent's BUILDD_HOME removed and HOME
 * pointed at a throwaway directory, so any store access that falls through to
 * `$HOME/.buildd` lands somewhere the parent can inspect. Exercises the write
 * AND read path of every runner module that persists under BUILDD_HOME, and
 * prints one line per call saying whether the store refused and with what.
 *
 * Reads matter as much as writes: a reader that resolves its path wrongly
 * either leaks (opens the real store) or crashes with something other than the
 * guard's error — which in production takes down whatever endpoint called it.
 */
import { sessionLog, claimLog, readSessionLogs, readClaimLogs } from '../../src/session-logger';
import { saveWorker, loadWorker, loadAllWorkers } from '../../src/worker-store';
import { archiveSession, initHistory, getArchivedData, getSession } from '../../src/history-store';
import { Outbox } from '../../src/outbox';

function attempt(name: string, fn: () => unknown): void {
  try {
    fn();
    console.log(`${name}:ok`);
  } catch (err) {
    console.log(`${name}:refused:${err instanceof Error ? err.name : 'unknown'}`);
  }
}

const worker = {
  id: 'probe-worker',
  taskId: 'probe-task',
  taskTitle: 'probe',
  workspaceId: 'probe-ws',
  workspaceName: 'probe',
  status: 'done',
  lastActivity: Date.now(),
  milestones: [],
  commits: [],
  output: [],
  toolCalls: [],
  messages: [],
} as any;

// Writers. Loggers swallow their own errors by design, so the parent judges
// them by the filesystem, not by this line.
attempt('session-logger.write', () => {
  sessionLog('probe-worker', 'info', 'probe');
  claimLog({ event: 'claim_attempt', slotsRequested: 1, workersClaimed: 0 });
});
attempt('worker-store.write', () => saveWorker(worker));
attempt('history-store.write', () => {
  initHistory();
  archiveSession(worker);
});
attempt('outbox.write', () => {
  // `save` is private; call it directly so the probe does not depend on which
  // endpoints `shouldQueue` currently accepts.
  (new Outbox() as any).save();
});

// Readers.
attempt('session-logger.readSessionLogs', () => readSessionLogs('probe-worker'));
attempt('session-logger.readClaimLogs', () => readClaimLogs());
attempt('worker-store.loadWorker', () => loadWorker('probe-worker'));
attempt('worker-store.loadAllWorkers', () => loadAllWorkers());
attempt('history-store.getSession', () => getSession('probe-worker'));
attempt('history-store.getArchivedData', () => getArchivedData('probe-worker'));
attempt('outbox.load', () => new Outbox().count());
