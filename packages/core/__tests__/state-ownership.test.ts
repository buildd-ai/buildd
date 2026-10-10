/**
 * One owner per state machine (docs/specs/execution-control-plane.md): Living
 * Specs owns spec revisions, approvals and artifacts; the execution control
 * plane (the workflow kernel) owns execution state. The kernel half is
 * workflow-write-sites.test.ts (only apps/web/src/lib/workflow/ touches the
 * workflow_* tables). This is the other half: Living Specs tables are written
 * only by Living Specs modules, never by the kernel, and the legacy writers
 * outside both are a list that can only shrink.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../../..');
const tracked = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /__tests__\//.test(f) || /(^|\/)tests\//.test(f);
const files = tracked.filter((f) => !isTest(f));

/** Living Specs tables: artifacts and their history, links and reads; spec revisions and approvals. */
const TABLES = 'artifacts|artifact_revisions|artifact_reads|artifact_links|specs|spec_revisions|spec_approvals';
const SYMBOLS = 'artifacts|artifactRevisions|artifactReads|artifactLinks|specs|specRevisions|specApprovals';
const SQL_WRITE = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(?:ONLY\\s+)?(?:"?public"?\\.)?"?(?:${TABLES})\\b`, 'i');
const DRIZZLE_WRITE = new RegExp(`\\b(?:insert|update|delete)\\(\\s*(?:${SYMBOLS})\\b`);

/** Living Specs' own modules. */
const OWNER = [
  /^apps\/web\/src\/app\/api\/artifacts\//,
  /^apps\/web\/src\/app\/api\/(?:workers|missions|workspaces|initiatives)\/\[id\]\/artifacts\//,
  /^apps\/web\/src\/lib\/artifact-[\w-]+\.ts$/,
  /^packages\/core\/artifact-[\w-]+\.ts$/,
  /^apps\/web\/src\/lib\/specs\//,
  /^apps\/web\/src\/app\/api\/specs\//,
];

/**
 * Writers outside Living Specs, as of the boundary decision (2026-10-10). Each
 * should move behind a Living Specs write API; the list may only shrink.
 */
const LEGACY: Record<string, string> = {
  'apps/web/src/app/api/workers/[id]/route.ts': 'an execution route: salvages a dying worker\'s output as an artifact',
  'apps/web/src/app/api/cron/orchestration-readout/route.ts': 'a cron writing its readout as an artifact',
  'apps/web/src/app/api/workspaces/[id]/migrate/precheck/route.ts': 'workspace migration precheck report',
  'apps/web/src/lib/mission-shipped-report.ts': 'mission "what shipped" report',
  'apps/web/src/lib/post-session-findings-store.ts': 'post-session quality findings',
  'apps/web/src/lib/workspace-migration.ts': 'copies artifacts when a workspace moves',
  'packages/core/memory-digest-readout-source.ts': 'memory digest readout',
};

const KERNEL_DIR = 'apps/web/src/lib/workflow/';

function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const writes = (f: string) => { const c = code(f); return SQL_WRITE.test(c) || DRIZZLE_WRITE.test(c); };

describe('Living Specs tables have one owner', () => {
  it('scans a real tree with the kernel and the artifact routes in it', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.startsWith(KERNEL_DIR))).toBe(true);
    expect(files).toContain('apps/web/src/app/api/artifacts/[artifactId]/route.ts');
  });

  it('the workflow kernel never writes a Living Specs table', () => {
    expect(files.filter((f) => f.startsWith(KERNEL_DIR) && writes(f))).toEqual([]);
  });

  it('every other writer is a Living Specs module or a listed legacy writer', () => {
    const offenders = files.filter((f) => writes(f) && !OWNER.some((re) => re.test(f)) && !(f in LEGACY));
    expect(offenders).toEqual([]);
  });

  it('the legacy list only names files that still write (so it can only shrink)', () => {
    const stale = Object.keys(LEGACY).filter((f) => !files.includes(f) || !writes(f));
    expect(stale).toEqual([]);
  });

  it('catches a write in each form it scans for', () => {
    for (const sample of ['await db.insert(artifacts).values({})', 'db.update(artifactRevisions).set({})', 'sql`UPDATE artifacts SET content = 1`', 'sql`DELETE FROM "public"."spec_revisions"`']) {
      expect(DRIZZLE_WRITE.test(sample) || SQL_WRITE.test(sample)).toBe(true);
    }
    expect(DRIZZLE_WRITE.test('db.select().from(artifacts)')).toBe(false);
  });
});
