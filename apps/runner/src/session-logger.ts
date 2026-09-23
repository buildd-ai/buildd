import * as fs from 'fs';
const { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, readFileSync } = fs;
import { join } from 'path';
import { resolveBuilddHome } from './buildd-home';

/** Resolved per call so a test runtime without a temp BUILDD_HOME fails closed (see buildd-home.ts). */
function logsDir(): string {
  return join(resolveBuilddHome(), 'logs');
}
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

export type SessionLogLevel = 'info' | 'warn' | 'error';

export interface SessionLogEntry {
  ts: number;
  level: SessionLogLevel;
  event: string;
  workerId: string;
  taskId?: string;
  detail?: string;
}

function ensureDir() {
  if (!existsSync(logsDir())) {
    mkdirSync(logsDir(), { recursive: true });
  }
}

function logPath(workerId: string): string {
  return join(logsDir(), `${workerId}.log`);
}

/** Append a structured log entry for a worker session */
export function sessionLog(workerId: string, level: SessionLogLevel, event: string, detail?: string, taskId?: string): void {
  try {
    ensureDir();
    const entry: SessionLogEntry = { ts: Date.now(), level, event, workerId, ...(taskId && { taskId }), ...(detail && { detail }) };
    appendFileSync(logPath(workerId), JSON.stringify(entry) + '\n');
  } catch {
    // Logging should never crash the app
  }
}

/** Read recent log entries for a worker (last N lines) */
export function readSessionLogs(workerId: string, maxLines = 50): SessionLogEntry[] {
  const path = logPath(workerId);
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

import type { ClaimDiagnosticReason, ClaimDiagnostics } from '@buildd/shared';

export interface ClaimLogEntry {
  ts: number;
  event: 'claim_attempt' | 'claim_success' | 'claim_empty' | 'claim_rejected';
  slotsRequested: number;
  workersClaimed: number;
  diagnosticReason?: ClaimDiagnosticReason;
  taskId?: string;
  /** HTTP status code on claim_rejected events */
  status?: number;
  /** Server-reported error/reason string on claim_rejected events */
  reason?: string;
  /**
   * Per-reason breakdown behind `all_candidates_deferred`, as computed by the
   * claim route. Logged because the aggregate reason alone cannot tell a paced
   * mission from a dead subject anchor, and that is the difference between
   * "working as designed" and a stall.
   *
   * Absent, not empty, when the server sent none.
   */
  deferrals?: ClaimDiagnostics['deferrals'];
  /** Candidate-window sizes: a deferral count is unreadable without them. */
  pendingTasks?: number;
  matchedTasks?: number;
}


/** Append a structured claim log entry */
export function claimLog(entry: Omit<ClaimLogEntry, 'ts'>): void {
  try {
    ensureDir();
    const full: ClaimLogEntry = { ts: Date.now(), ...entry };
    appendFileSync(join(logsDir(), 'claims.log'), JSON.stringify(full) + '\n');
  } catch {
    // Logging should never crash the app
  }
}

/** Read recent claim log entries (last N lines) */
export function readClaimLogs(maxLines = 50): ClaimLogEntry[] {
  if (!existsSync(CLAIMS_LOG)) return [];
  try {
    const content = readFileSync(CLAIMS_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Clean up log files older than 48 hours */
export function cleanupOldLogs(): void {
  let dir: string;
  try { dir = logsDir(); } catch { return; }
  if (!existsSync(dir)) return;
  const now = Date.now();
  try {
    for (const file of readdirSync(dir)) {
      // claims.log holds months of the best forensic data available and is
      // append-only — its mtime only looks fresh while the runner is
      // actively claiming, so an idle runner would otherwise age it past
      // MAX_AGE_MS and this sweep would delete it. Same exemption doctor.ts's
      // disk-usage cleanup already applies by name.
      if (!file.endsWith('.log') || file === 'claims.log') continue;
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
