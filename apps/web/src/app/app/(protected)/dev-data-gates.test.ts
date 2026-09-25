/**
 * Dev-mode data gates: reads may un-gate, writes may not.
 *
 * The `NODE_ENV === 'development'` short-circuits date from the first dashboard
 * scaffold, when local dev had no database. Keyed on NODE_ENV alone they kept
 * `bun dev` blank even with a real DATABASE_URL and DEV_USER_EMAIL (which
 * getCurrentUser already honours), so local QA could not see these pages.
 *
 * READS (pages, GET handlers) now serve real data only when dev has BOTH a
 * DATABASE_URL and a DEV_USER_EMAIL; otherwise they keep the placeholder
 * (a DB with only the mock dev user would render empty pages or 500).
 *
 * WRITES stay short-circuited on NODE_ENV alone. The usual local DATABASE_URL
 * points at production, so an un-gated POST /api/tasks from `bun dev` creates a
 * real task that production runners claim. Keep it that way.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = import.meta.dir;
const API_ROOT = join(ROOT, '../../api');

function files(dir: string, name: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return files(p, name);
    return entry === name ? [p] : [];
  });
}

const DEV = /process\.env\.NODE_ENV\s*===\s*'development'/;
const REQUIRES_DB = /!process\.env\.DATABASE_URL/;
const REQUIRES_DEV_USER = /!process\.env\.DEV_USER_EMAIL/;

/**
 * GET routes that stay gated: they authenticate with next-auth `auth()`
 * directly, and local dev has no session under DEV_USER_EMAIL, so un-gating
 * would turn an empty response into a 401 rather than real data. The fix is
 * moving them to getCurrentUser. Shrink this list only.
 */
const AUTH_SESSION_ONLY = new Set([
  'workspaces/[id]/accounts/route.ts',
  'github/installations/route.ts',
  'github/installations/[id]/route.ts',
  'github/installations/[id]/repos/route.ts',
]);

interface Gate {
  file: string;
  /** Enclosing exported HTTP handler, or null for a non-exported helper. */
  handler: string | null;
  line: string;
}

/** Every `if (… NODE_ENV === 'development' …)` in app/api, tagged with its handler. */
function apiGates(): Gate[] {
  return files(API_ROOT, 'route.ts').flatMap((path) => {
    const file = path.slice(API_ROOT.length + 1);
    let handler: string | null = null;
    const out: Gate[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const fn = line.match(/^export\s+(?:async\s+)?function\s+([A-Z]+)\b/);
      if (fn) handler = fn[1];
      else if (/^(?:async\s+)?function\s/.test(line) || /^export\s+(?:async\s+)?function\s+[a-z]/.test(line)) handler = null;
      if (/^\s*if\s*\(/.test(line) && DEV.test(line)) out.push({ file, handler, line: line.trim() });
    }
    return out;
  });
}

describe('dev data gates: pages (reads)', () => {
  const GATE = /const\s+isDev\s*=\s*process\.env\.NODE_ENV\s*===\s*'development'([^;]*);/;
  const gated = files(ROOT, 'page.tsx')
    .map((f) => ({ file: f.slice(ROOT.length + 1), m: readFileSync(f, 'utf8').match(GATE) }))
    .filter((g) => g.m);

  it('finds the gated pages (guards against matching nothing)', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(['home/page.tsx', 'tasks/page.tsx', 'workspaces/page.tsx'])('%s is among them', (f) => {
    expect(gated.map((g) => g.file)).toContain(f);
  });

  it('every page gate keeps the placeholder unless dev has a DATABASE_URL and a DEV_USER_EMAIL', () => {
    const bad = gated.filter((g) => !REQUIRES_DB.test(g.m![1]) || !REQUIRES_DEV_USER.test(g.m![1])).map((g) => g.file);
    expect(bad).toEqual([]);
  });
});

describe('dev data gates: API', () => {
  const gates = apiGates();
  const reads = gates.filter((g) => g.handler === 'GET' && !AUTH_SESSION_ONLY.has(g.file));
  const writes = gates.filter((g) => g.handler !== 'GET');

  it('finds GET and mutation gates (guards against matching nothing)', () => {
    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.map((g) => g.file)).toContain('tasks/route.ts');
    expect(writes.map((g) => `${g.file} ${g.handler}`)).toContain('tasks/route.ts POST');
  });

  it('GET gates serve real data only with a DATABASE_URL and a DEV_USER_EMAIL', () => {
    const bad = reads
      .filter((g) => !REQUIRES_DB.test(g.line) || !REQUIRES_DEV_USER.test(g.line))
      .map((g) => `${g.file} GET: ${g.line}`);
    expect(bad).toEqual([]);
  });

  it('mutation gates (POST/PUT/PATCH/DELETE and shared auth helpers) still short-circuit on NODE_ENV alone', () => {
    // A DATABASE_URL condition here would let `bun dev` write to whatever DB it
    // points at — usually production.
    const unGated = writes.filter((g) => REQUIRES_DB.test(g.line)).map((g) => `${g.file} ${g.handler ?? '(helper)'}: ${g.line}`);
    expect(unGated).toEqual([]);
  });

  it('the auth()-only GET exemptions are still real (drop one once its route moves to getCurrentUser)', () => {
    for (const f of AUTH_SESSION_ONLY) {
      const src = readFileSync(join(API_ROOT, f), 'utf8');
      expect(src).toContain('await auth()');
      expect(src).not.toContain('getCurrentUser');
    }
  });
});
