import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideRepo, parseReadoutArgs } from './orchestration-readout';

/** The operator command's arguments and its never-commit output guard. */

const NOW = new Date('2026-03-01T00:00:00.000Z');

describe('parseReadoutArgs', () => {
  it('requires a workspace and a start date', () => {
    expect(() => parseReadoutArgs([], NOW)).toThrow(/--workspace/);
    expect(() => parseReadoutArgs(['--workspace', 'w'], NOW)).toThrow(/--since/);
  });

  it('defaults: until now, later window = last quarter, mission links on, no sample-floor override', () => {
    const a = parseReadoutArgs(['--workspace', 'w', '--since', '2026-01-01T00:00:00.000Z'], NOW);
    expect(a.until).toEqual(NOW);
    const span = NOW.getTime() - a.since.getTime();
    expect(a.laterFrom.getTime()).toBe(NOW.getTime() - span / 4);
    expect(a.linkMissions).toBe(true);
    expect(a.minN).toBeNull();
    expect(a.out).toBeNull();
  });

  it('rejects malformed windows and floors', () => {
    const base = ['--workspace', 'w', '--since', '2026-01-01'];
    expect(() => parseReadoutArgs([...base, '--until', '2025-01-01'], NOW)).toThrow(/before/);
    expect(() => parseReadoutArgs([...base, '--later-from', '2027-01-01'], NOW)).toThrow(/inside/);
    expect(() => parseReadoutArgs([...base, '--held-out', '1.5'], NOW)).toThrow(/share/);
    expect(() => parseReadoutArgs([...base, '--min-n', '0'], NOW)).toThrow(/positive/);
    expect(parseReadoutArgs([...base, '--no-mission-links', '--min-n', '12'], NOW)).toMatchObject({ linkMissions: false, minN: 12 });
  });
});

describe('isInsideRepo', () => {
  it('refuses any path under the repository root', () => {
    expect(isInsideRepo('/repo/docs/readout.json', '/repo')).toBe(true);
    expect(isInsideRepo('/repo', '/repo')).toBe(true);
    expect(isInsideRepo('/private/readout.json', '/repo')).toBe(false);
    expect(isInsideRepo('/repo-other/x.json', '/repo')).toBe(false);
  });

  it('follows symlinks: a link outside the repo that points inside it is refused', () => {
    const base = mkdtempSync(join(tmpdir(), 'readout-'));
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    symlinkSync(join(repo, 'docs'), join(base, 'link'));
    expect(isInsideRepo(join(base, 'link', 'readout.json'), repo)).toBe(true);
    expect(isInsideRepo(join(base, 'elsewhere', 'readout.json'), repo)).toBe(false);
  });
});
