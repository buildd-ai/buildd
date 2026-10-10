import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, chmodSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync, utimesSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { captureDependencyManifest, verifyDependencyHandover } from '../../src/dependency-manifest';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'deps-')); roots.push(repoRoot);
  const storeDir = join(repoRoot, 'store'); const content = 'export default 1;';
  const hash = createHash('sha512').update(content).digest('hex');
  const store = join(storeDir, 'files', hash.slice(0, 2), hash.slice(2));
  mkdirSync(join(storeDir, 'files', hash.slice(0, 2)), { recursive: true }); writeFileSync(store, content);
  const file = join(repoRoot, 'node_modules', 'pkg', 'index.js'); mkdirSync(join(repoRoot, 'node_modules', 'pkg'), { recursive: true }); linkSync(store, file);
  const expected = captureDependencyManifest(repoRoot);
  const verify = (trackedPaths: string[] = []) => verifyDependencyHandover({ repoRoot, storeDir, expected, expectedDigest: expected.digest, trackedPaths });
  return { repoRoot, storeDir, store, file, expected, verify };
}
describe('dependency handover (synthetic pnpm sha512 content-addressed store)', () => {
  test('unchanged dependencies pass', () => { expect(fixture().verify().fellBack).toBe(false); });
  test('append with restored mtime removes store and links', () => { const f = fixture(); writeFileSync(f.file, 'export default 1;!'); utimesSync(f.file, 1, 1); const r = f.verify(); expect(r.entriesChanged).toBeGreaterThan(0); expect(existsSync(f.file)).toBe(false); expect(existsSync(f.store)).toBe(false); });
  test('store corruption removes every hardlink', () => { const f = fixture(); const other = join(f.repoRoot, 'node_modules/pkg/other.js'); linkSync(f.store, other); const expected = captureDependencyManifest(f.repoRoot); writeFileSync(f.file, 'corrupt'); const report = verifyDependencyHandover({ ...f, expected, expectedDigest: expected.digest }); expect(report.fellBack).toBe(false); expect(report.entriesDeleted).toBeGreaterThanOrEqual(3); expect(existsSync(other)).toBe(false); expect(existsSync(f.store)).toBe(false); });
  test('changed generated non-store file is deleted', () => { const f = fixture(); const p = join(f.repoRoot, 'node_modules/pkg/output.js.cache'); writeFileSync(p, 'initial'); const expected = captureDependencyManifest(f.repoRoot); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); writeFileSync(p, 'changed'); const r = verifyDependencyHandover({ ...f, expected, expectedDigest: expected.digest }); expect(r.fellBack).toBe(false); expect(existsSync(p)).toBe(false); });
  test('orphaned store corruption is removed before a future install', () => { const f = fixture(); const hash = createHash('sha512').update('original').digest('hex'); const p = join(f.storeDir, 'files', hash.slice(0, 2), hash.slice(2)); mkdirSync(join(f.storeDir, 'files', hash.slice(0, 2)), { recursive: true }); writeFileSync(p, 'corrupt'); const r = f.verify(); expect(r.fullStoreHash).toBe(true); expect(existsSync(p)).toBe(false); });
  test('repository bin outside node_modules survives', () => { const f = fixture(); const p = join(f.repoRoot, '.bin/tool'); mkdirSync(join(f.repoRoot, '.bin')); writeFileSync(p, 'repo tool'); f.verify(); expect(existsSync(p)).toBe(true); });
  test('same-size replacement inode is deleted', () => { const f = fixture(); unlinkSync(f.file); writeFileSync(f.file, 'export default 2;'); f.verify(); expect(existsSync(f.file)).toBe(false); });
  test('replaced directory explains deleted descendants without falling back', () => { const f = fixture(); const directory = join(f.repoRoot, 'node_modules/pkg'); const replacement = join(f.repoRoot, 'replacement'); mkdirSync(replacement); writeFileSync(join(replacement, 'index.js'), 'planted'); rmSync(directory, { recursive: true }); renameSync(replacement, directory); const report = f.verify(); expect(report.fellBack).toBe(false); expect(existsSync(directory)).toBe(false); });
  test('chmod is explained and original mode restored', () => { const f = fixture(); chmodSync(f.file, 0o777); const r = f.verify(); expect(r.fellBack).toBe(false); expect(r.entriesExplained).toBeGreaterThan(0); expect(readFileSync(f.file, 'utf8')).toBe('export default 1;'); });
  test('new package file is deleted', () => { const f = fixture(); const p = join(f.repoRoot, 'node_modules/pkg/planted.js'); writeFileSync(p, 'bad'); f.verify(); expect(existsSync(p)).toBe(false); });
  test('changed symlink is deleted', () => { const f = fixture(); const p = join(f.repoRoot, 'node_modules/link'); symlinkSync('pkg', p); const expected = captureDependencyManifest(f.repoRoot); unlinkSync(p); symlinkSync('/tmp', p); const r = verifyDependencyHandover({ ...f, expected, expectedDigest: expected.digest }); expect(r.entriesChanged).toBeGreaterThan(0); expect(existsSync(p)).toBe(false); });
  test('planted bin shim is deleted', () => { const f = fixture(); const p = join(f.repoRoot, 'node_modules/.bin/tool'); mkdirSync(join(f.repoRoot, 'node_modules/.bin')); writeFileSync(p, 'bad'); f.verify(); expect(existsSync(p)).toBe(false); });
  test('untrusted digest falls back and tracked fixtures survive', () => { const f = fixture(); const p = join(f.repoRoot, 'test/node_modules/fixture.js'); mkdirSync(join(f.repoRoot, 'test/node_modules'), { recursive: true }); writeFileSync(p, 'tracked'); const r = verifyDependencyHandover({ ...f, expectedDigest: 'bad', trackedPaths: ['test/node_modules/fixture.js'] }); expect(r.fellBack).toBe(true); expect(existsSync(f.file)).toBe(false); expect(existsSync(p)).toBe(true); });
});

// A local packed package exercises the actual pnpm layout without registry/network access.
test('real pnpm frozen install regenerates a deleted planted bin shim', () => {
  const base = mkdtempSync(join(tmpdir(), 'dependency-fixture-')); roots.push(base);
  const repoRoot = join(base, 'repo'); const storeDir = join(base, 'store');
  const packageDir = join(base, 'package');
  mkdirSync(repoRoot); mkdirSync(packageDir);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'warm-fixture-bin', version: '1.0.0', bin: { 'warm-fixture-bin': 'cli.js' } }));
  writeFileSync(join(packageDir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("trusted fixture");\n');
  chmodSync(join(packageDir, 'cli.js'), 0o755);
  const packed = spawnSync('tar', ['-czf', join(base, 'fixture.tgz'), '-C', base, 'package']);
  expect(packed.status).toBe(0);
  // An empty workspace file pins pnpm's root here, so it never walks up into an enclosing checkout.
  writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { 'warm-fixture-bin': 'file:../fixture.tgz' } }));
  const install = (frozen: boolean) => spawnSync('pnpm', ['install', '--ignore-scripts', '--store-dir', storeDir, ...(frozen ? ['--frozen-lockfile'] : ['--no-frozen-lockfile'])], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60000, env: { ...process.env, CI: 'true', HOME: base },
  });
  const initial = install(false);
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  const expected = captureDependencyManifest(repoRoot);
  expect(expected.entries.some(e => e.path === 'node_modules/.bin/warm-fixture-bin')).toBe(true);
  const shim = join(repoRoot, 'node_modules/.bin/warm-fixture-bin');
  expect(existsSync(shim)).toBe(true);
  writeFileSync(shim, '#!/bin/sh\necho planted\n');
  const report = verifyDependencyHandover({ repoRoot, storeDir, expected, expectedDigest: expected.digest });
  expect(report.fellBack, JSON.stringify(report)).toBe(false);
  expect(existsSync(shim)).toBe(false);
  expect(existsSync(join(repoRoot, 'node_modules/warm-fixture-bin/cli.js'))).toBe(true);
  const retainedFiles = spawnSync('find', [storeDir, '-type', 'f', '-printf', '%P\n'], { encoding: 'utf8' }).stdout.trim();
  expect(retainedFiles.length).toBeGreaterThan(0);
  const repaired = install(true);
  expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
  expect(readFileSync(shim, 'utf8')).not.toContain('planted');
  const run = spawnSync(shim, [], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe('trusted fixture');
}, 120000);
