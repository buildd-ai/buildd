import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findDrizzleKit, runDrizzleCheck } from '../db/migration-layout';
import { V1_FOLDER } from '../db/migrate-tree';
import { entityKey, planReparent, serializeSnapshot, type V1Snapshot } from '../db/snapshot-reparent';

/**
 * The re-parent is a stand-in for `migrations:regenerate`, so the pinned kit is
 * the judge. Two branches generate off one base with the real drizzle-kit; the
 * merged tree forks; the re-parent is written in place of the mission's folder;
 * then the kit must see one linear chain (`check`) and nothing left to generate
 * for the merged schema (`generate` reports no changes). Without a drizzle-kit
 * install this file proves nothing, so it fails rather than skips.
 */
describe('a re-parented snapshot is what the pinned drizzle-kit would have generated', () => {
  const repoRoot = resolve(import.meta.dir, '../../..');
  let dir: string;
  const pkg = () => join(dir, 'pkg');
  const drizzle = () => join(dir, 'pkg', 'drizzle');
  const sh = (cmd: string, args: string[], cwd = dir) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env } });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r;
  };
  const generate = (...extra: string[]) => sh(findDrizzleKit(pkg()), ['generate', ...extra], pkg());
  const folders = () => readdirSync(drizzle()).filter((f) => V1_FOLDER.test(f)).sort();
  const readSnap = (folder: string): V1Snapshot => JSON.parse(readFileSync(join(drizzle(), folder, 'snapshot.json'), 'utf8'));
  const schema = (name: string, body: string) => writeFileSync(join(pkg(), 'schema', `${name}.ts`), body);
  const tableFile = (name: string, cols: string) =>
    `import { pgTable, text, integer, index } from 'drizzle-orm/pg-core';\nexport const ${name} = pgTable('${name}', { id: text('id').primaryKey()${cols} });\n`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-reparent-kit-'));
    symlinkSync(join(repoRoot, 'packages/core/node_modules'), join(dir, 'node_modules'));
    mkdirSync(join(dir, 'pkg', 'schema'), { recursive: true });
    writeFileSync(
      join(dir, 'pkg', 'drizzle.config.ts'),
      `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './schema', out: './drizzle', dialect: 'postgresql' });\n`,
    );
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('mission adds a table with an index and trunk adds a column elsewhere: re-parent, then check passes and generate is a no-op', () => {
    // Base: table a(id, v).
    schema('a', tableFile('a', ", v: text('v')"));
    generate('--name=init');
    const [baseFolder] = folders();
    const base = readSnap(baseFolder!);

    // The mission adds table m with an index on it (its own folder, parented on base).
    schema('m', `import { pgTable, text, index } from 'drizzle-orm/pg-core';\nexport const m = pgTable('m', { id: text('id').primaryKey(), k: text('k') }, (t) => [index('m_k_idx').on(t.k)]);\n`);
    generate('--name=mission_m');
    const missionFolder = folders().find((f) => f.endsWith('_mission_m'))!;
    const missionSql = readFileSync(join(drizzle(), missionFolder, 'migration.sql'), 'utf8');
    const mission = { folder: missionFolder, snapshot: readSnap(missionFolder) };
    // Set the mission aside: trunk generates from the same base.
    rmSync(join(drizzle(), missionFolder), { recursive: true });
    rmSync(join(pkg(), 'schema', 'm.ts'));

    // Trunk adds a.n and table b (one folder, parented on base).
    schema('a', tableFile('a', ", v: text('v'), n: integer('n')"));
    schema('b', tableFile('b', ''));
    // Folder prefixes are to the second: make sure trunk's sorts after the mission's.
    const until = Date.now() + 1100;
    while (Date.now() < until) { /* spin one second */ }
    generate('--name=trunk_b');
    const trunkFolder = folders().find((f) => f.endsWith('_trunk_b'))!;
    const trunk = { folder: trunkFolder, snapshot: readSnap(trunkFolder) };
    expect(trunk.snapshot.prevIds).toEqual([base.id]);
    expect(mission.snapshot.prevIds).toEqual([base.id]);

    // The merged tree: both folders, both schema files. This is what a clean refresh leaves.
    mkdirSync(join(drizzle(), missionFolder));
    writeFileSync(join(drizzle(), missionFolder, 'migration.sql'), missionSql);
    writeFileSync(join(drizzle(), missionFolder, 'snapshot.json'), serializeSnapshot(mission.snapshot));
    schema('m', `import { pgTable, text, index } from 'drizzle-orm/pg-core';\nexport const m = pgTable('m', { id: text('id').primaryKey(), k: text('k') }, (t) => [index('m_k_idx').on(t.k)]);\n`);

    // The re-parent, as the refresh writes it: the mission folder moves past trunk's with the same SQL.
    const plan = planReparent({ base, trunk: [trunk], mission: [mission], existingFolders: folders() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [moved] = plan.folders;
    rmSync(join(drizzle(), missionFolder), { recursive: true });
    mkdirSync(join(drizzle(), moved!.to));
    writeFileSync(join(drizzle(), moved!.to, 'migration.sql'), missionSql);
    writeFileSync(join(drizzle(), moved!.to, 'snapshot.json'), serializeSnapshot(moved!.snapshot));
    expect(folders()).toEqual([baseFolder!, trunkFolder, moved!.to]);

    // The kit's verdicts: one linear chain, and the merged schema is exactly what the snapshot says.
    const check = runDrizzleCheck(pkg());
    expect(check.output).not.toMatch(/Non-commutative/);
    expect(check.ok).toBe(true);
    expect(generate().stdout).toContain('No schema changes');

    // And it is the regenerate's answer: the kit's own regeneration of the same schema holds the same entities.
    rmSync(join(drizzle(), moved!.to), { recursive: true });
    generate('--name=mission_m_by_kit');
    const byKit = readSnap(folders().find((f) => f.endsWith('_mission_m_by_kit'))!);
    expect(byKit.prevIds).toEqual([trunk.snapshot.id]);
    expect(new Set(byKit.ddl.map(entityKey))).toEqual(new Set(moved!.snapshot.ddl.map(entityKey)));
    expect(readFileSync(join(drizzle(), folders().find((f) => f.endsWith('_mission_m_by_kit'))!, 'migration.sql'), 'utf8')).toBe(missionSql);
  }, 180_000);
});
