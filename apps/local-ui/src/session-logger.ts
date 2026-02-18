import * as fs from 'fs';
const { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, readFileSync } = fs;
import { join } from 'path';
import { homedir } from 'os';

const LOGS_DIR = join(homedir(), '.buildd', 'logs');
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
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function logPath(workerId: string): string {
  return join(LOGS_DIR, `${workerId}.log`);
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

/** Clean up log files older than 48 hours */
export function cleanupOldLogs(): void {
  if (!existsSync(LOGS_DIR)) return;
  const now = Date.now();
  try {
    for (const file of readdirSync(LOGS_DIR)) {
      if (!file.endsWith('.log')) continue;
      const filePath = join(LOGS_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
