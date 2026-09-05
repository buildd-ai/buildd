import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  apiRouteTable,
  claimedApiRoutes,
  claimedSymbols,
  codeSurfacePaths,
  resolveApiRoute,
  resolveSymbols,
  VERIFIED_BY_DEBT,
} from './check-specs';

/**
 * Guards for the checks that make `specs:lint` test whether a spec is TRUE
 * rather than merely well-formed: symbol liveness, route-URL liveness, and the
 * `verified_by` ratchet.
 *
 * Written because the checks themselves assert that an unguarded contract is not
 * a contract. Shipping them unguarded would have been the same defect one level up.
 */

const SPECS_DIR = join(import.meta.dir, '..', 'docs/specs');
const META = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);

function specSlugs(): string[] {
  return readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md') && !META.has(f))
    .map((f) => f.replace(/\.md$/, ''));
}

function frontmatterOf(slug: string): string {
  const raw = readFileSync(join(SPECS_DIR, `${slug}.md`), 'utf8');
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? '' : raw.slice(3, end);
}

function bodyOf(slug: string): string {
  const raw = readFileSync(join(SPECS_DIR, `${slug}.md`), 'utf8');
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw : raw.slice(end + 4);
}

describe('claimedSymbols', () => {
  test('claims camelCase with an internal hump', () => {
    expect(claimedSymbols('the guard `isCleanupExpiry` runs first')).toEqual(['isCleanupExpiry']);
  });

  test('claims SCREAMING_SNAKE constants', () => {
    expect(claimedSymbols('past `QUEUE_STALL_THRESHOLD` it alerts')).toEqual([
      'QUEUE_STALL_THRESHOLD',
    ]);
  });

  test('strips a trailing call form', () => {
    expect(claimedSymbols('`derivePolicy()` returns')).toEqual(['derivePolicy']);
  });

  test('ignores paths, prose, and dotted expressions — codeSurfacePaths owns paths', () => {
    const body = 'see `apps/runner/src/workers.ts`, `resultMeta.cbm`, and `a real sentence`';
    expect(claimedSymbols(body)).toEqual([]);
  });

  test('ignores PascalCase and snake_case: mostly library types and third-party tool names', () => {
    // `NextRequest` is imported, `index_repository` is a CBM tool — neither is ours
    // to guarantee, and including them produced the only false positives observed.
    expect(claimedSymbols('`NextRequest` calls `index_repository`')).toEqual([]);
  });

  test('deduplicates repeated claims', () => {
    expect(claimedSymbols('`buildCbmActivation` … `buildCbmActivation`')).toEqual([
      'buildCbmActivation',
    ]);
  });
});

describe('resolveSymbols', () => {
  test('a symbol that exists in the source tree is not reported dead', () => {
    expect([...resolveSymbols(['buildCbmActivation'])]).toEqual([]);
  });

  test('a symbol that exists nowhere is reported dead', () => {
    expect([...resolveSymbols(['zzzNotARealSymbolInThisRepo'])]).toEqual([
      'zzzNotARealSymbolInThisRepo',
    ]);
  });

  test('a symbol that exists ONLY under docs/ is reported dead', () => {
    // `buildWorkerMountAllowlist` is named by three design docs and never shipped;
    // the code exports `buildWorkerBwrapArgv`. A spec citing the design's name is
    // exactly the drift this check exists to catch, so docs must not satisfy it.
    expect([...resolveSymbols(['buildWorkerMountAllowlist'])]).toEqual([
      'buildWorkerMountAllowlist',
    ]);
  });

  test('resolves a mixed batch in one pass', () => {
    const dead = resolveSymbols(['buildCbmActivation', 'zzzAlsoNotReal', 'CBM_BINARY_PATH']);
    expect([...dead]).toEqual(['zzzAlsoNotReal']);
  });

  test('an empty claim set does no work', () => {
    expect(resolveSymbols([]).size).toBe(0);
  });
});

describe('verified_by ratchet', () => {
  test('every slug on the debt list is a real spec', () => {
    const slugs = new Set(specSlugs());
    const stale = [...VERIFIED_BY_DEBT].filter((slug) => !slugs.has(slug));
    expect(stale, 'debt list names specs that no longer exist — prune it').toEqual([]);
  });

  test('a spec that has gained guards is off the debt list', () => {
    // The ratchet only shrinks. Leaving a slug here after its tests exist means
    // the warning keeps firing and the count stops meaning anything.
    const paidOff = [...VERIFIED_BY_DEBT].filter((slug) => {
      const match = /^verified_by:\s*\[(.*)\]/m.exec(frontmatterOf(slug));
      return !!match && match[1].trim().length > 0;
    });
    expect(paidOff, 'these specs now name guards — remove them from VERIFIED_BY_DEBT').toEqual([]);
  });

  test('no new spec joins the debt list', () => {
    // 19 pre-existing specs owed guards when the check landed on 2026-08-30, and
    // mcp-action-contracts paid its debt off with the on-demand-review guards.
    // The number is asserted so growing it requires editing this test and
    // explaining why.
    expect(VERIFIED_BY_DEBT.size).toBeLessThanOrEqual(18);
  });
});

describe('codeSurfacePaths', () => {
  // A multi-section spec repeats the `Code surface` label per section. Reading only
  // the first match left sections 2..N unchecked, so a dead path in a later section
  // passed the linter — work-tracker-integration.md had three sections and its §3
  // named a route that does not exist, while specs:lint reported 0 errors.
  test('collects paths from every Code surface section, not just the first', () => {
    const body = [
      '## 1. First capability',
      '**Code surface**: `apps/web/src/one.ts`',
      '',
      '## 2. Second capability',
      '**Code surface**: `apps/web/src/two.ts`',
      '',
      '## 3. Third capability',
      '**Code surface**: `apps/web/src/three.ts`',
    ].join('\n');

    expect(codeSurfacePaths(body).sort()).toEqual([
      'apps/web/src/one.ts',
      'apps/web/src/three.ts',
      'apps/web/src/two.ts',
    ]);
  });

  test('handles the three label spellings within one body', () => {
    const body = [
      '**Code surface**: `apps/a.ts`',
      '',
      '## Code surface',
      '`packages/b.ts`',
      '',
      '**Other label**: not a surface',
      '',
      'Code surface: `scripts/c.ts`',
    ].join('\n');

    expect(codeSurfacePaths(body).sort()).toEqual(['apps/a.ts', 'packages/b.ts', 'scripts/c.ts']);
  });

  test('still stops at the next label so neighbouring prose is not scanned', () => {
    const body = [
      '**Code surface**: `apps/web/src/real.ts`',
      '',
      '**Invariants**: `apps/web/src/not-a-surface.ts` is only mentioned',
    ].join('\n');

    expect(codeSurfacePaths(body)).toEqual(['apps/web/src/real.ts']);
  });

  test('returns nothing when a body has no Code surface section', () => {
    expect(codeSurfacePaths('## Overview\nJust prose about `apps/web/src/x.ts`.')).toEqual([]);
  });
});

describe('claimedApiRoutes', () => {
  test('extracts the path out of a backticked method+path claim', () => {
    expect(claimedApiRoutes('`POST /api/connectors` creates or reuses')).toEqual([
      '/api/connectors',
    ]);
  });

  test('keeps dynamic segments and strips a query string', () => {
    expect(claimedApiRoutes('`GET /api/workers/[id]/artifacts?limit=10`')).toEqual([
      '/api/workers/[id]/artifacts',
    ]);
  });

  test('strips trailing punctuation without eating a closing bracket', () => {
    expect(claimedApiRoutes('see (`GET /api/tasks/[id]`), then')).toEqual(['/api/tasks/[id]']);
    expect(claimedApiRoutes('`GET /api/missions/[id]/notes.`')).toEqual([
      '/api/missions/[id]/notes',
    ]);
  });

  test('ignores file paths — codeSurfacePaths owns those', () => {
    const body = 'handler is `apps/web/src/app/api/workers/[id]/route.ts:45`';
    expect(claimedApiRoutes(body)).toEqual([]);
  });

  test('ignores a bare `/api` root: it claims no endpoint', () => {
    expect(claimedApiRoutes('everything under `/api` is coordination-only')).toEqual([]);
  });

  test('reads fenced code blocks too — a curl example is a claim', () => {
    const body = ['```bash', 'curl -X POST https://buildd.dev/api/tasks/claim', '```'].join('\n');
    expect(claimedApiRoutes(body)).toEqual(['/api/tasks/claim']);
  });

  test('ignores un-backticked prose, which is how a spec says NOT IMPLEMENTED', () => {
    // The escape hatch, mirroring SPEC-FORMAT rule 7 for symbols: backticks mean
    // "this is live, go check it". Without it, stating that
    // /api/connectors/probe does not exist would itself fail the linter, and the
    // only way to a green build would be deleting the requirement.
    const body = 'A standalone probe endpoint (/api/connectors/probe) is NOT implemented.';
    expect(claimedApiRoutes(body)).toEqual([]);
  });

  test('deduplicates repeated claims', () => {
    expect(claimedApiRoutes('`POST /api/missions` … `GET /api/missions`')).toEqual([
      '/api/missions',
    ]);
  });
});

describe('resolveApiRoute', () => {
  // A hand-built table so these assertions do not move when the app-router tree
  // does. Shape matches apiRouteTable(): one segment array per route.ts.
  const table = [
    ['api', 'connectors'],
    ['api', 'connectors', '[id]'],
    ['api', 'connectors', '[id]', 'shares'],
    ['api', 'workspaces', '[workspaceId]', 'skills'],
    ['api', 'cron', 'queue-stall'],
    ['api', 'auth', '[...nextauth]'],
  ];

  test('rejects a fabricated route even when a dynamic sibling would swallow it', () => {
    // The defect this check exists for: /api/connectors/probe was asserted as
    // "(existing)" by an active spec and was never built. Next.js would route
    // that request to the [id] handler, so a matcher that lets a literal fall
    // through to a dynamic directory calls the fabrication live.
    expect(resolveApiRoute('/api/connectors/probe', table)).toBeNull();
  });

  test('rejects a fabricated route with dynamic segments in it', () => {
    expect(resolveApiRoute('/api/connectors/[id]/workspaces/[wsId]', table)).toBeNull();
  });

  test('accepts a dynamic route whose parameter the spec renamed', () => {
    // The parameter name is not the contract: the directory is [workspaceId].
    expect(resolveApiRoute('/api/workspaces/[wsId]/skills', table)).toBe('route');
  });

  test('accepts every placeholder spelling the corpus uses for an id', () => {
    for (const seg of ['[id]', '{workspaceId}', '<ws>', '${wsId}', ':wsId', 'W']) {
      expect(resolveApiRoute(`/api/workspaces/${seg}/skills`, table), seg).toBe('route');
    }
  });

  test('a placeholder does NOT satisfy a literal directory', () => {
    // `/api/[thing]/shares` must not pass by pretending `connectors` is a param.
    expect(resolveApiRoute('/api/[thing]/shares', table)).toBeNull();
  });

  test('resolves an exact literal route', () => {
    expect(resolveApiRoute('/api/cron/queue-stall', table)).toBe('route');
  });

  test('a wildcard segment matches any one route segment', () => {
    expect(resolveApiRoute('/api/cron/*', table)).toBe('route');
  });

  test('a catch-all route absorbs the segments under it', () => {
    expect(resolveApiRoute('/api/auth/[...nextauth]', table)).toBe('route');
    expect(resolveApiRoute('/api/auth/signin/github', table)).toBe('route');
  });

  test('a namespace prefix resolves as `namespace`, not as a route', () => {
    // Prose legitimately names a family (`/api/cron`, `/api/.well-known`).
    expect(resolveApiRoute('/api/cron', table)).toBe('namespace');
  });

  test('a namespace that prefixes nothing is unresolved', () => {
    expect(resolveApiRoute('/api/schedules', table)).toBeNull();
    expect(resolveApiRoute('/api/nope/at/all', table)).toBeNull();
  });

  test('a shorter path is not satisfied by a longer route of the same prefix', () => {
    // /api/connectors/[id]/shares exists; /api/connectors/[id]/shares/[x] does not.
    expect(resolveApiRoute('/api/connectors/[id]/shares/[shareId]', table)).toBeNull();
  });
});

describe('route liveness against the real route tree', () => {
  test('the app-router table is populated', () => {
    expect(apiRouteTable().length).toBeGreaterThan(50);
  });

  test('a real route resolves, a fabricated neighbour does not', () => {
    expect(resolveApiRoute('/api/workers/claim')).toBe('route');
    expect(resolveApiRoute('/api/workers/claim-it-all')).toBeNull();
  });

  test('a real dynamic route resolves under a renamed parameter', () => {
    expect(resolveApiRoute('/api/workspaces/[wsId]/skills')).toBe('route');
  });

  test('the runner-local server counts as a route source', () => {
    // The runner's HTTP surface is a Bun switch, not a file tree. Without it a
    // spec citing the local doctor endpoint would be reported as fabricated.
    expect(resolveApiRoute('/api/doctor')).toBe('route');
  });

  test('the corpus is measured: extraction is non-zero', () => {
    // The gate's own failure mode is silence. If a regex edit or a corpus
    // reformat stops extraction, this goes red before the linter reports clean.
    const total = specSlugs().reduce((n, slug) => n + claimedApiRoutes(bodyOf(slug)).length, 0);
    expect(total, 'no /api URLs extracted anywhere — the route gate measures nothing').toBeGreaterThan(50);
  });

  test('no active spec claims a route that does not exist', () => {
    const dead: string[] = [];
    for (const slug of specSlugs()) {
      if (!/^status:\s*active\b/m.test(frontmatterOf(slug))) continue;
      for (const url of claimedApiRoutes(bodyOf(slug))) {
        if (!resolveApiRoute(url)) dead.push(`${slug}: ${url}`);
      }
    }
    expect(dead, 'active specs assert endpoints nobody serves').toEqual([]);
  });
});
