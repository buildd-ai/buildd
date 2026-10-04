import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
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

/**
 * Senders that predate the authority and are being migrated onto `wakeTask`.
 * May only shrink: the test fails when a listed file stops sending, so the
 * entry is removed in the same change that fixes it.
 */
const SENDER_PENDING_MIGRATION = new Set([
  'apps/web/src/app/api/tasks/[id]/start/route.ts', // manual start broadcasts directly
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
    const offenders = taskAssignedSenders().filter(p => !SENDER_ALLOWED.has(p) && !SENDER_PENDING_MIGRATION.has(p));
    expect(offenders).toEqual([]);
  });

  it('the pending-migration list only shrinks', () => {
    const senders = new Set(taskAssignedSenders());
    const migrated = [...SENDER_PENDING_MIGRATION].filter(p => !senders.has(p));
    // A file that no longer sends must leave the list, so it cannot regress silently.
    expect(migrated).toEqual([]);
  });
});

// ── (b) deprecated wrapper imports: ratchet to zero ───────────────────────

const WRAPPERS = ['dispatchNewTask', 'dispatchUnblockedTask', 'dispatchRetriedTask', 'dispatchPlanChildTask'] as const;

/**
 * Non-test files importing a deprecated wrapper from lib/task-dispatch.
 * Lower it as call sites move to `wakeTask` / `announceTaskCreated`; never raise it.
 */
const WRAPPER_IMPORT_BASELINE = 35;

const MODULE = String.raw`(?:@/lib/|\./|\.\./(?:\.\./)*lib/)task-dispatch`;
const STATIC_IMPORT = new RegExp(String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]${MODULE}['"]`, 'g');
const DYNAMIC_IMPORT = new RegExp(String.raw`import\(\s*['"]${MODULE}['"]\s*\)`);
const WRAPPER_WORD = new RegExp(String.raw`\b(?:${WRAPPERS.join('|')})\b`);

/** Whether `src` imports a deprecated wrapper (static named import, or a dynamic import that uses one). */
function importsDeprecatedWrapper(src: string): boolean {
  for (const m of src.matchAll(STATIC_IMPORT)) {
    if (WRAPPER_WORD.test(m[1])) return true;
  }
  return DYNAMIC_IMPORT.test(src) && WRAPPER_WORD.test(src);
}

function wrapperImporters(): string[] {
  const tracked = new Set(trackedSources());
  return grepFiles(String.raw`['"]${MODULE}['"]`)
    .filter(p => tracked.has(p) && p !== 'apps/web/src/lib/task-dispatch.ts')
    .filter(p => importsDeprecatedWrapper(readFileSync(join(REPO, p), 'utf8')));
}

describe('deprecated task-dispatch wrappers are not gaining importers', () => {
  it('the pattern catches a wrapper import (the guard can fail)', () => {
    expect(importsDeprecatedWrapper(`import { dispatchNewTask } from '@/lib/task-dispatch';`)).toBe(true);
    expect(importsDeprecatedWrapper(`import {\n  buildTaskPayload,\n  dispatchRetriedTask,\n} from "./task-dispatch";`)).toBe(true);
    expect(importsDeprecatedWrapper(`import { dispatchNewTask as d } from '../../lib/task-dispatch';`)).toBe(true);
    expect(importsDeprecatedWrapper(`const [{ dispatchNewTask }] = await Promise.all([import('@/lib/task-dispatch')]);`)).toBe(true);
    expect(importsDeprecatedWrapper(`import { dispatchResumedTask } from '@/lib/task-dispatch';`)).toBe(false);
    expect(importsDeprecatedWrapper(`import { dispatchNewTask } from '@/lib/task-dispatch-delivery';`)).toBe(false);
    expect(importsDeprecatedWrapper(`// dispatchNewTask used to live here\nimport { x } from '@/lib/other';`)).toBe(false);
  });

  it(`at most ${WRAPPER_IMPORT_BASELINE} files import one`, () => {
    const files = wrapperImporters();
    if (files.length > WRAPPER_IMPORT_BASELINE) {
      console.error(`New wrapper importers — use wakeTask / announceTaskCreated:\n  ${files.join('\n  ')}`);
    }
    expect(files.length).toBeLessThanOrEqual(WRAPPER_IMPORT_BASELINE);
  });
});
