/** Metadata is only trusted after its digest matches the baseline held outside the container. */
import { createHash } from 'crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'fs';
import { join, relative, resolve } from 'path';

export const DEPENDENCY_MANIFEST_FILENAME = '.buildd-deps-manifest.json';

export function findDependencyRoots(repoRoot: string): string[] {
  const roots: string[] = [];
  walk(repoRoot, (_absolute, path) => {
    if (path === '.git') return false;
    if (path.split('/').at(-1) === 'node_modules') { roots.push(path); return false; }
  });
  return roots;
}

export interface DependencyEntry {
  path: string; dev: number; ino: number; size: number; ctimeMs: number; ctimeNs: string; mode: number;
  kind: 'file' | 'directory' | 'symlink' | 'other'; target?: string;
}
export interface DependencyManifest { version: 1; entries: DependencyEntry[]; digest: string }
export interface DependencyHandoverReport {
  verifyMs: number; entriesChanged: number; entriesExplained: number; entriesDeleted: number;
  fellBack: boolean; reason?: string; storeHashMs: number; fullStoreHash: boolean;
}
function noise(path: string): boolean {
  return /(^|\/)node_modules\/(?:.*\/)?\.bin\/.+/.test(path) || /(^|\/)node_modules\/\.modules\.yaml$/.test(path)
    || /(^|\/)node_modules\/\.pnpm\/lock\.yaml$/.test(path)
    || /(^|\/)node_modules\/\.pnpm\/node_modules\/.+/.test(path);
}
function walk(root: string, visitor: (absolute: string, path: string) => boolean | void): void {
  if (!existsSync(root)) return;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('unsafe_root');
  const visit = (absolute: string) => {
    const path = relative(root, absolute).split('\\').join('/');
    if (visitor(absolute, path) === false) return;
    if (lstatSync(absolute).isDirectory()) for (const name of readdirSync(absolute).sort()) visit(join(absolute, name));
  };
  for (const name of readdirSync(root).sort()) visit(join(root, name));
}
function digest(entries: DependencyEntry[]): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, entries })).digest('hex');
}
export function captureDependencyManifest(repoRoot: string): DependencyManifest {
  const entries: DependencyEntry[] = [];
  walk(repoRoot, (absolute, path) => {
    if (path === '.git') return false;
    if (!path.split('/').includes('node_modules')) return;
    const st = lstatSync(absolute, { bigint: true });
    const kind = st.isFile() ? 'file' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'other';
    entries.push({ path, dev: Number(st.dev), ino: Number(st.ino), size: Number(st.size), ctimeMs: Number(st.ctimeMs), ctimeNs: st.ctimeNs.toString(), mode: Number(st.mode), kind,
      ...(kind === 'symlink' ? { target: readlinkSync(absolute) } : {}) });
  });
  return { version: 1, entries, digest: digest(entries) };
}
function protectedPath(path: string, tracked: string[]): boolean {
  return tracked.some(p => p === path || p.startsWith(`${path}/`));
}
/** trackedPaths must be supplied by the runner's trusted reconstructed git index, never old clone config. */
export function wipeDependenciesGitAware(repoRoot: string, storeDir: string, trackedPaths: string[] = []): void {
  if (existsSync(repoRoot) && lstatSync(repoRoot).isDirectory() && !lstatSync(repoRoot).isSymbolicLink()) walk(repoRoot, (absolute, path) => {
    if (path === '.git') return false;
    if (path.split('/').includes('node_modules') && !protectedPath(path, trackedPaths)) {
      rmSync(absolute, { recursive: true, force: true }); return false;
    }
  });
  const relStore = relative(resolve(repoRoot), resolve(storeDir));
  if (!protectedPath(relStore, trackedPaths)) rmSync(storeDir, { recursive: true, force: true });
}
export function verifyDependencyHandover(options: {
  repoRoot: string; storeDir: string; expected: DependencyManifest | null;
  expectedDigest: string; trackedPaths?: string[];
}): DependencyHandoverReport {
  const start = performance.now();
  const report: DependencyHandoverReport = { verifyMs: 0, entriesChanged: 0, entriesExplained: 0, entriesDeleted: 0, fellBack: false, storeHashMs: 0, fullStoreHash: false };
  const { repoRoot, storeDir, expected, expectedDigest, trackedPaths = [] } = options;
  const finish = () => { report.verifyMs = Math.round(performance.now() - start); return report; };
  const fallback = (reason: string) => { report.fellBack = true; report.reason = reason; wipeDependenciesGitAware(repoRoot, storeDir, trackedPaths); return finish(); };
  try {
    if (!expected || expected.version !== 1 || digest(expected.entries) !== expectedDigest) return fallback('manifest_digest_mismatch');
    if (expected.entries.some(e => e.path.startsWith('/') || e.path.split('/').includes('..') || !e.path.split('/').includes('node_modules'))) return fallback('invalid_manifest_path');
    walk(repoRoot, (absolute, path) => {
      if (path === '.git') return false;
      if (noise(path)) {
        if (protectedPath(path, trackedPaths)) throw new Error('tracked_regenerable_dependency');
        rmSync(absolute, { recursive: true, force: true }); report.entriesDeleted++; return false;
      }
    });
    const current = captureDependencyManifest(repoRoot);
    const old = new Map(expected.entries.filter(e => !noise(e.path)).map(e => [e.path, e]));
    const now = new Map(current.entries.map(e => [e.path, e]));
    const storeByInode = new Map<string, string[]>();
    walk(storeDir, (absolute) => {
      const st = lstatSync(absolute);
      if (st.isSymbolicLink()) { rmSync(absolute, { force: true }); report.entriesDeleted++; return false; }
      if (!st.isFile() && !st.isDirectory()) throw new Error('unsafe_store_entry');
      if (st.isFile()) { const key = `${st.dev}:${st.ino}`; storeByInode.set(key, [...(storeByInode.get(key) ?? []), absolute]); }
    });
    const removedPaths = new Set<string>();
    const wasRemoved = (path: string) => {
      let candidate = path;
      while (candidate) {
        if (removedPaths.has(candidate)) return true;
        const slash = candidate.lastIndexOf('/');
        candidate = slash < 0 ? '' : candidate.slice(0, slash);
      }
      return false;
    };
    const remove = (path: string) => {
      if (wasRemoved(path)) return;
      if (protectedPath(path, trackedPaths)) throw new Error('tracked_dependency_changed');
      rmSync(join(repoRoot, path), { recursive: true, force: true }); report.entriesDeleted++; removedPaths.add(path);
    };
    for (const path of new Set([...old.keys(), ...now.keys()])) {
      const a = old.get(path), b = now.get(path);
      if (wasRemoved(path)) { report.entriesChanged++; report.entriesExplained++; continue; }
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      report.entriesChanged++;
      if (!b) { report.entriesExplained++; continue; } // frozen install repairs removed files
      if (a?.kind === 'directory' && b.kind === 'directory' && a.ino === b.ino && a.dev === b.dev) {
        if (a.mode !== b.mode) chmodSync(join(repoRoot, path), a.mode & 0o7777); report.entriesExplained++; continue;
      }
      if (b.kind !== 'file' || !a || a.ino !== b.ino || a.dev !== b.dev || a.kind !== 'file') {
        remove(path); report.entriesExplained++; continue;
      }
      const stores = storeByInode.get(`${b.dev}:${b.ino}`) ?? [];
      if (!stores.length) { remove(path); report.entriesExplained++; continue; }
      const actual = createHash('sha512').update(readFileSync(join(repoRoot, path))).digest('hex');
      const matches = stores.every(s => {
        const storePath = relative(storeDir, s).split('/');
        const filename = storePath.at(-1)!.replace(/-exec$/, '');
        return /^[a-f0-9]{126}$/.test(filename) && `${storePath.at(-2)}${filename}` === actual;
      });
      if (matches) { chmodSync(join(repoRoot, path), a.mode & 0o7777); report.entriesExplained++; continue; }
      for (const e of current.entries) if (e.dev === b.dev && e.ino === b.ino) remove(e.path);
      for (const s of stores) { rmSync(s, { force: true }); report.entriesDeleted++; }
      report.entriesExplained++;
    }
    // The next lockfile may reference a store entry no current package links to.
    // Authenticate every retained content file; package index metadata is regenerable.
    const hashStart = performance.now();
    report.fullStoreHash = true;
    walk(storeDir, (absolute, path) => {
      const st = lstatSync(absolute);
      if (!st.isFile()) return;
      const parts = path.split('/');
      const filename = parts.at(-1)!.replace(/-exec$/, '');
      const expectedHash = `${parts.at(-2)}${filename}`;
      const validName = /^[a-f0-9]{128}$/.test(expectedHash);
      const actual = validName ? createHash('sha512').update(readFileSync(absolute)).digest('hex') : null;
      if (actual === expectedHash) return;
      for (const entry of current.entries) if (entry.dev === st.dev && entry.ino === st.ino && existsSync(join(repoRoot, entry.path))) remove(entry.path);
      rmSync(absolute, { force: true }); report.entriesDeleted++;
      return false;
    });
    report.storeHashMs = Math.round(performance.now() - hashStart);
    return finish();
  } catch (error) { return fallback(error instanceof Error ? error.message : 'verification_failed'); }
}
