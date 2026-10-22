/**
 * Claude Code on Windows keys ~/.claude.json `projects` with forward slashes
 * (`C:/code/buildd`), while process.cwd() there is `C:\code\buildd`. An entry
 * written under the backslash key is never read, so `buildd install --here`
 * printed "registered" while the old entry stayed in effect. The platform is
 * injected, so these run the same on every host.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { candidateFolders, claudeProjectKey, mcpStatusLines, planMcpRegistration } from '../../src/agent-plugin-install';

const keyEntry = { type: 'http', url: 'https://b.test/api/mcp', headers: { Authorization: 'Bearer bld_old' } };
const oauthEntry = { type: 'http', url: 'https://b.test/api/mcp' };
const other = { command: 'other-server' };

describe('claudeProjectKey', () => {
  it('uses forward slashes on win32 and leaves other platforms alone', () => {
    expect(claudeProjectKey('C:\\code\\buildd', 'win32')).toBe('C:/code/buildd');
    expect(claudeProjectKey('C:/code/buildd', 'win32')).toBe('C:/code/buildd');
    expect(claudeProjectKey('/home/me/odd\\name', 'linux')).toBe('/home/me/odd\\name');
  });
});

describe('planMcpRegistration on win32', () => {
  const here = (claudeJson: any) => planMcpRegistration({
    claudeJson, entry: keyEntry, oauthEntry: () => oauthEntry, mode: 'here', cwd: 'C:\\code\\buildd',
    candidates: [{ path: 'C:\\code\\buildd', repo: 'acme/buildd' }], workspaceRepos: ['acme/buildd'], platform: 'win32',
  });

  it('--here writes under the forward-slash key Claude Code reads, replacing the old key entry', () => {
    const plan = here({ projects: { 'C:/code/buildd': { allowedTools: ['Bash(ls)'], mcpServers: { buildd: keyEntry, other } } } });
    expect(Object.keys(plan.config.projects)).toEqual(['C:/code/buildd']);
    expect(plan.config.projects['C:/code/buildd']).toEqual({ allowedTools: ['Bash(ls)'], mcpServers: { buildd: oauthEntry, other } });
    expect(plan.folders[0].path).toBe('C:/code/buildd');
  });

  it('folds a backslash duplicate an older install wrote into the forward-slash entry', () => {
    const plan = here({
      projects: {
        'C:/code/buildd': { allowedTools: ['Bash(ls)'], mcpServers: { buildd: keyEntry } },
        'C:\\code\\buildd': { mcpServers: { buildd: oauthEntry, other } },
      },
    });
    expect(Object.keys(plan.config.projects)).toEqual(['C:/code/buildd']);
    expect(plan.config.projects['C:/code/buildd']).toEqual({ allowedTools: ['Bash(ls)'], mcpServers: { buildd: oauthEntry, other } });
  });

  it('--global folds a backslash buildd entry for a folder it does not write, and leaves non-buildd keys alone', () => {
    const plan = planMcpRegistration({
      claudeJson: {
        projects: {
          'C:\\code\\stale': { mcpServers: { buildd: keyEntry } },
          'C:\\code\\untouched': { mcpServers: { other } },
          'C:/code/widget': {},
        },
      },
      entry: keyEntry, mode: 'workspaces', cwd: 'C:\\Users\\me',
      candidates: [{ path: 'C:/code/widget', repo: 'acme/widget' }, { path: 'C:\\code\\stale', repo: null }],
      workspaceRepos: ['acme/widget'], platform: 'win32',
    });
    expect(Object.keys(plan.config.projects).sort()).toEqual(['C:/code/stale', 'C:/code/widget', 'C:\\code\\untouched']);
    expect(plan.config.projects['C:/code/stale'].mcpServers.buildd).toEqual(keyEntry);
    expect(plan.config.projects['C:/code/widget'].mcpServers.buildd).toEqual(keyEntry);
  });

  it('changes nothing about the key on linux', () => {
    const plan = planMcpRegistration({
      claudeJson: {}, entry: keyEntry, mode: 'here', cwd: '/home/me/a\\b',
      candidates: [{ path: '/home/me/a\\b', repo: null }], workspaceRepos: [], platform: 'linux',
    });
    expect(Object.keys(plan.config.projects)).toEqual(['/home/me/a\\b']);
  });
});

describe('candidateFolders on win32', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts a backslash cwd and the forward-slash key for it as one folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'buildd-winkey-'));
    const forward = dir.replace(/\\/g, '/');
    const backslash = dir.replace(/\//g, '\\');
    const found = candidateFolders({ projects: { [forward]: {} } }, backslash, 'win32');
    expect(found.map(f => f.path)).toEqual([forward]);
  });
});

describe('mcpStatusLines on win32', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('flags a backslash entry, which Claude Code never reads', () => {
    home = mkdtempSync(join(tmpdir(), 'buildd-winkey-home-'));
    mkdirSync(join(home, '.buildd'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      projects: {
        'C:\\code\\buildd': { mcpServers: { buildd: oauthEntry } },
        'C:/code/widget': { mcpServers: { buildd: keyEntry } },
      },
    }));
    const lines = mcpStatusLines(home, { BUILDD_HOME: join(home, '.buildd') }, 'win32');
    const bad = lines.find(l => l.includes('C:\\code\\buildd'))!;
    expect(bad).toContain("Claude Code doesn't read this entry");
    expect(lines.find(l => l.includes('C:/code/widget'))).not.toContain("doesn't read");
  });
});
