import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectProjects } from './detect-projects';

let tmpDir: string;

function makeTmp(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'detect-projects-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('detectProjects', () => {
  it('detects projects from workspaces array format', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*', 'packages/*'],
    }));

    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@mono/web' }));

    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@mono/core' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name).sort()).toEqual(['@mono/core', '@mono/web']);
    expect(projects.find(p => p.name === '@mono/web')!.path).toBe(join(root, 'apps', 'web'));
  });

  it('detects projects from workspaces object format', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: { packages: ['apps/*'] },
    }));

    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    writeFileSync(join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: '@mono/api' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('@mono/api');
  });

  it('handles exact directory paths (no wildcard)', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/web'],
    }));

    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@mono/web' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('@mono/web');
    expect(projects[0].path).toBe(join(root, 'apps', 'web'));
  });

  it('returns root project when no workspaces field but has name', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('my-app');
    expect(projects[0].path).toBe(root);
  });

  it('returns empty array when no package.json exists', () => {
    const root = makeTmp();

    const projects = detectProjects(root);

    expect(projects).toEqual([]);
  });

  it('returns empty array when no workspaces and no name', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    const projects = detectProjects(root);

    expect(projects).toEqual([]);
  });

  it('skips directories without package.json', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*'],
    }));

    // Create two dirs, only one with package.json
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@mono/web' }));

    mkdirSync(join(root, 'apps', 'no-pkg'), { recursive: true });
    // no package.json here

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('@mono/web');
  });

  it('skips non-directory entries (files in glob parent)', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*'],
    }));

    mkdirSync(join(root, 'apps'), { recursive: true });
    // Create a file (not a directory) in apps/
    writeFileSync(join(root, 'apps', 'README.md'), '# README');

    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@mono/web' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('@mono/web');
  });

  it('skips entries where package.json has no name', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*'],
    }));

    mkdirSync(join(root, 'apps', 'unnamed'), { recursive: true });
    writeFileSync(join(root, 'apps', 'unnamed', 'package.json'), JSON.stringify({ version: '1.0.0' }));

    mkdirSync(join(root, 'apps', 'named'), { recursive: true });
    writeFileSync(join(root, 'apps', 'named', 'package.json'), JSON.stringify({ name: '@mono/named' }));

    const projects = detectProjects(root);

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('@mono/named');
  });

  it('handles nonexistent glob parent directory gracefully', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['nonexistent/*'],
    }));

    const projects = detectProjects(root);

    expect(projects).toEqual([]);
  });
});
