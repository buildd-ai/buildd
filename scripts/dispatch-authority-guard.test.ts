import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Task wakes have one sender: the dispatch authority
// (apps/web/src/lib/dispatch-authority.ts, docs/specs/task-dispatch-authority.md).
// A path that broadcasts TASK_ASSIGNED itself skips the outbox, so its wake is
// lost on a crash, never retried, invisible to dispatch history, and bypasses
// the per-cause webhook policy. State changes call `wakeTask(id, cause)`.

const REPO = join(import.meta.dir, '..');

// ── (a) TASK_ASSIGNED has one sender ──────────────────────────────────────

/** Files that may name the event without being a second sender, and why. */
const SENDER_ALLOWED = new Set([
  'apps/web/src/lib/dispatch-authority.ts', // the sender
  'apps/web/src/lib/pusher.ts', // defines the event name
]);

const SENDER_RE = /\bevents\.TASK_ASSIGNED\b|['"`]task:assigned['"`]/;

/** Whether `src` names the TASK_ASSIGNED event (the event constant or its wire name). */
function namesTaskAssigned(src: string): boolean {
  return SENDER_RE.test(src);
}

function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'scripts'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(p =>
    /\.(ts|tsx)$/.test(p)
    && !/\.test\.tsx?$/.test(p)
    && !p.includes('/__tests__/')
    && !p.includes('/tests/')
    && !p.includes('/drizzle/')
    && !p.includes('node_modules')
    // Runners listen for the event; they never send it.
    && !p.startsWith('apps/runner/')
    && !p.startsWith('apps/cloud-runner/'),
  );
}

function grepFiles(pattern: string): string[] {
  // -P, not -E: `git grep -E` drops `\b` and silently matches nothing.
  try {
    const out = execFileSync('git', ['grep', '-lP', pattern, '--', 'apps', 'packages', 'scripts'], { cwd: REPO, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []; // no match
    throw err;
  }
}

function taskAssignedSenders(): string[] {
  const tracked = new Set(trackedSources());
  return grepFiles(String.raw`\bevents\.TASK_ASSIGNED\b|['"\x60]task:assigned['"\x60]`)
    .filter(p => tracked.has(p))
    .filter(p => namesTaskAssigned(readFileSync(join(REPO, p), 'utf8')));
}

describe('TASK_ASSIGNED is sent only by the dispatch authority', () => {
  it('the pattern catches a direct send (the guard can fail)', () => {
    expect(namesTaskAssigned(`await triggerEvent(ch, events.TASK_ASSIGNED, { task })`)).toBe(true);
    expect(namesTaskAssigned(`pusher.trigger(ch, 'task:assigned', data)`)).toBe(true);
    expect(namesTaskAssigned('client.trigger(ch, `task:assigned`, data)')).toBe(true);
    expect(namesTaskAssigned(`await triggerEvent(ch, events.TASK_CREATED, { task })`)).toBe(false);
    expect(namesTaskAssigned(`events.TASK_ASSIGNED_LATER`)).toBe(false);
  });

  it('git grep sees the authority itself (the scan is not empty)', () => {
    expect(taskAssignedSenders()).toContain('apps/web/src/lib/dispatch-authority.ts');
  });

  it('no other source file sends it', () => {
    const offenders = taskAssignedSenders().filter(p => !SENDER_ALLOWED.has(p));
    expect(offenders).toEqual([]);
  });
});

// ── (b) the pre-outbox dispatch module stays gone ────────────────────────

/**
 * lib/task-dispatch.ts held five ad-hoc senders (dispatchNewTask & co.), each
 * waking runners in its own way and none atomically with the write. It was
 * deleted once every call site moved to `wakeTask` / `announceTaskCreated`;
 * the delivery primitives live on in task-dispatch-delivery.ts.
 */
const OLD_MODULE = String.raw`['"](?:@/lib/|\./|\.\./(?:\.\./)*lib/)task-dispatch['"]`;

describe('the pre-outbox dispatch module stays gone', () => {
  it('the pattern catches an import of it (the guard can fail)', () => {
    const re = new RegExp(OLD_MODULE);
    expect(re.test(`import { dispatchNewTask } from '@/lib/task-dispatch';`)).toBe(true);
    expect(re.test(`mock.module("../../lib/task-dispatch", () => ({}))`)).toBe(true);
    expect(re.test(`import { buildTaskPayload } from '@/lib/task-dispatch-delivery';`)).toBe(false);
  });

  it('lib/task-dispatch.ts does not exist', () => {
    expect(existsSync(join(REPO, 'apps/web/src/lib/task-dispatch.ts'))).toBe(false);
  });

  it('nothing imports or mocks it', () => {
    // git grep only sees tracked files; tests count too — a stale mock.module
    // of a deleted path silently stubs nothing.
    expect(grepFiles(OLD_MODULE).filter(p => p !== 'scripts/dispatch-authority-guard.test.ts')).toEqual([]);
  });
});
