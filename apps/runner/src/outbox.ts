import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.buildd');
const OUTBOX_FILE = join(CONFIG_DIR, 'outbox.json');

export interface OutboxEntry {
  id: string;
  method: string;
  endpoint: string;
  body?: string;
  timestamp: number;
  retries: number;
}

// Endpoints that should NOT be queued (time-sensitive or read-only)
const EXCLUDED_ENDPOINTS = [
  '/api/workers/claim',    // Claiming is time-sensitive
  '/api/tasks/',           // Task reassign/delete are interactive
];

function shouldQueue(method: string, endpoint: string): boolean {
  // Only queue mutations
  if (method === 'GET') return false;
  // Skip excluded endpoints
  for (const excluded of EXCLUDED_ENDPOINTS) {
    if (endpoint.includes(excluded) && !endpoint.includes('/api/workers/') ) return false;
  }
  // Specifically queue worker updates and memory saves
  if (endpoint.match(/\/api\/workers\/[^/]+$/) && method === 'PATCH') return true;
  if (endpoint.includes('/memory') && method === 'POST') return true;
  if (endpoint.includes('/plan') && method === 'POST') return true;
  return false;
}

export class Outbox {
  private entries: OutboxEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInterval = 30_000; // Start at 30s
  private maxInterval = 300_000;  // Max 5 min
  private onFlush: ((entry: OutboxEntry) => Promise<boolean>) | null = null;

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (existsSync(OUTBOX_FILE)) {
        const data = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
        this.entries = Array.isArray(data.entries) ? data.entries : [];
      }
    } catch {
      this.entries = [];
    }
  }

  private save() {
    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(OUTBOX_FILE, JSON.stringify({ entries: this.entries, updatedAt: Date.now() }, null, 2));
    } catch (err) {
      console.error('Failed to save outbox:', err);
    }
  }

  /** Check if a failed request should be queued */
  shouldQueue(method: string, endpoint: string): boolean {
    return shouldQueue(method, endpoint);
  }

  /** Add a failed request to the outbox */
  enqueue(method: string, endpoint: string, body?: string) {
    if (!this.shouldQueue(method, endpoint)) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Deduplicate: for PATCH on same endpoint, keep only latest
    if (method === 'PATCH') {
      this.entries = this.entries.filter(e => !(e.method === 'PATCH' && e.endpoint === endpoint));
    }

    this.entries.push({ id, method, endpoint, body, timestamp: Date.now(), retries: 0 });
    this.save();
    console.log(`Outbox: queued ${method} ${endpoint} (${this.entries.length} pending)`);

    // Start flush timer if not running
    this.startFlushTimer();
  }

  /** Get pending count */
  count(): number {
    return this.entries.length;
  }

  /** Get all entries (for status display) */
  getEntries(): OutboxEntry[] {
    return [...this.entries];
  }

  /** Set the flush handler (called for each entry to replay) */
  setFlushHandler(handler: (entry: OutboxEntry) => Promise<boolean>) {
    this.onFlush = handler;
  }

  /** Attempt to flush all pending entries */
  async flush(): Promise<{ flushed: number; failed: number; remaining: number }> {
    if (!this.onFlush || this.entries.length === 0) {
      return { flushed: 0, failed: 0, remaining: this.entries.length };
    }

    console.log(`Outbox: flushing ${this.entries.length} pending entries...`);

    let flushed = 0;
    let failed = 0;
    const remaining: OutboxEntry[] = [];

    // Process in order (oldest first)
    for (const entry of this.entries) {
      try {
        const success = await this.onFlush(entry);
        if (success) {
          flushed++;
        } else {
          entry.retries++;
          // Drop entries that have failed too many times (stale)
          if (entry.retries < 10) {
            remaining.push(entry);
          } else {
            console.log(`Outbox: dropping ${entry.method} ${entry.endpoint} after ${entry.retries} retries`);
            failed++;
          }
        }
      } catch {
        entry.retries++;
        if (entry.retries < 10) {
          remaining.push(entry);
        } else {
          failed++;
        }
      }
    }

    this.entries = remaining;
    this.save();

    if (flushed > 0) {
      console.log(`Outbox: flushed ${flushed}, ${remaining.length} remaining`);
      // Reset backoff on success
      this.flushInterval = 30_000;
    } else if (remaining.length > 0) {
      // Backoff on failure
      this.flushInterval = Math.min(this.flushInterval * 2, this.maxInterval);
    }

    // Continue timer if entries remain
    if (remaining.length > 0) {
      this.startFlushTimer();
    } else {
      this.stopFlushTimer();
    }

    return { flushed, failed, remaining: remaining.length };
  }

  /** Start periodic flush timer */
  private startFlushTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flush();
    }, this.flushInterval);
  }

  /** Stop flush timer */
  private stopFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Clear all entries */
  clear() {
    this.entries = [];
    this.save();
    this.stopFlushTimer();
  }
}
