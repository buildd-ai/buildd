/**
 * A terminal state the runner settles on its own (a restart it could not
 * continue, a crash it reconciles) reaches the server, or the runner keeps
 * trying.
 *
 * These reports used to be one fire-and-forget `updateWorker(...).catch(() =>
 * {})`. When it failed (the start is the moment the network and the server are
 * least likely to be ready, and the outbox may not be attached yet) nothing
 * sent it again: the local record read `error` and the server row stayed
 * `running` while the runner heartbeated, which no reaper touches.
 *
 * The report is stored on the worker (`terminalReport`, persisted) before the
 * first try and cleared only when the server answers: accepted, or refused
 * with a 4xx (its decision; resending the same body changes nothing). A
 * transport failure or a 5xx is retried with backoff for as long as the
 * process runs, and the next start sends a report still on disk.
 */
import type { LocalWorker } from './types';
import { isServerRefusal } from './server-refusal';

/** Delay before each retry; the last one repeats. */
export const TERMINAL_REPORT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 2 * 60_000, 5 * 60_000];

export type TerminalReportOutcome = 'acked' | 'refused' | 'retrying';

export interface TerminalReportDeps {
  send: (workerId: string, payload: Record<string, unknown>) => Promise<unknown>;
  save: (worker: LocalWorker) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: (line: string) => void;
}

/** A refusal the same body will always get: anything 4xx but a timeout or a rate limit. */
function isFinalRefusal(err: unknown): boolean {
  return isServerRefusal(err) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** Store `payload` as the worker's pending terminal report and send it. */
export function reportTerminal(worker: LocalWorker, payload: Record<string, unknown>, deps: TerminalReportDeps): Promise<TerminalReportOutcome> {
  worker.terminalReport = { payload, since: Date.now(), attempts: 0 };
  deps.save(worker);
  return deliverTerminalReport(worker, deps);
}

/** Send the worker's pending terminal report; on a transient failure, schedule the next try. */
export async function deliverTerminalReport(worker: LocalWorker, deps: TerminalReportDeps): Promise<TerminalReportOutcome> {
  const report = worker.terminalReport;
  if (!report) return 'acked';
  const log = deps.log ?? ((l: string) => console.warn(l));
  try {
    await deps.send(worker.id, report.payload);
    if (worker.terminalReport === report) {
      worker.terminalReport = undefined;
      deps.save(worker);
    }
    return 'acked';
  } catch (err) {
    if (isFinalRefusal(err)) {
      log(`[terminal-report] server refused the terminal report for worker ${worker.id} (${(err as { status: number }).status}); not resending`);
      if (worker.terminalReport === report) {
        worker.terminalReport = undefined;
        deps.save(worker);
      }
      return 'refused';
    }
    report.attempts = (report.attempts ?? 0) + 1;
    deps.save(worker);
    const delay = TERMINAL_REPORT_BACKOFF_MS[Math.min(report.attempts - 1, TERMINAL_REPORT_BACKOFF_MS.length - 1)];
    log(`[terminal-report] terminal report for worker ${worker.id} not delivered (attempt ${report.attempts}): ${err instanceof Error ? err.message : String(err)}; retrying in ${Math.round(delay / 1000)}s`);
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    setTimer(() => {
      // A later report (or a person's resume) replaced or cleared this one.
      if (worker.terminalReport !== report) return;
      void deliverTerminalReport(worker, deps);
    }, delay);
    return 'retrying';
  }
}
