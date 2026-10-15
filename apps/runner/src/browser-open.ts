/**
 * When the runner may open its debug page in a browser on its own (spec
 * c7410e76 R-28, AC-13).
 *
 * Only the first interactive `--debug` start of a person at a terminal. Never
 * after the runner restarted itself (an applied update exits 75 and the
 * launcher starts it again), after a crash restart, under launchd or systemd,
 * or without a terminal: a page that opens by itself at some later hour is a
 * surprise, not help.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Written just before the runner exits for a restart; the next start consumes it. */
export const RESTART_MARKER = '.restart-pending';
/** A marker older than this is a leftover from a run that never came back. */
const RESTART_MARKER_TTL_MS = 10 * 60_000;
/** The old guard: never twice within a minute. */
const DEBOUNCE_MS = 60_000;

export interface BrowserOpenInput {
  /** The saved `openBrowser` preference. */
  preference: boolean | undefined;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** True when this start follows a restart the runner announced itself. */
  restartMarkerPresent: boolean;
  /** When the browser was last opened (ms), if ever. */
  lastOpenAt: number | null;
  now: number;
}

/** Set by a service manager that started this process, not by a person. */
function startedByServiceManager(env: Record<string, string | undefined>): boolean {
  return !!env.INVOCATION_ID || !!env.JOURNAL_STREAM || (!!env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0');
}

export function shouldAutoOpenBrowser(i: BrowserOpenInput): boolean {
  if (!i.preference) return false;
  if (!i.isTTY) return false;
  if (i.restartMarkerPresent) return false;
  if (i.env.BUILDD_RESTART) return false;
  if (startedByServiceManager(i.env)) return false;
  if (i.lastOpenAt !== null && i.now - i.lastOpenAt < DEBOUNCE_MS) return false;
  return true;
}

/** Leave a note that the exit about to happen is a restart, not a fresh start. */
export function writeRestartMarker(dir: string, now: number = Date.now()): void {
  try { writeFileSync(join(dir, RESTART_MARKER), String(now)); } catch { /* best effort */ }
}

/** Is a fresh restart note there? Reads and removes it, so one restart silences one start. */
export function consumeRestartMarker(dir: string, now: number = Date.now()): boolean {
  const file = join(dir, RESTART_MARKER);
  try {
    if (!existsSync(file)) return false;
    const at = parseInt(readFileSync(file, 'utf-8').trim(), 10);
    try { unlinkSync(file); } catch { /* ignore */ }
    return !Number.isNaN(at) && now - at < RESTART_MARKER_TTL_MS;
  } catch {
    return false;
  }
}
