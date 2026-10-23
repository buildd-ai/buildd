import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  buildCodexInstructionDoc,
  writeCodexAgentsMd,
  healStaleCodexAgentsMd,
  restoreCodexAgentsMd,
  BUILDD_AGENTS_BEGIN,
  BUILDD_AGENTS_END,
} from '../../src/codex-instructions';

// Use fs/promises throughout: the sync `fs` exports (notably rmSync) trip a Bun
// aggregate-run module-loading quirk; fs/promises is unaffected and is also what
// the production source module uses.
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('buildCodexInstructionDoc', () => {
  test('includes role persona text', () => {
    const doc = buildCodexInstructionDoc({
      rolePersona: 'You are the Builder. You write production code and never leave TODOs.',
      skillBundles: [],
    });
    expect(doc).toContain('You are the Builder');
    expect(doc).toContain('never leave TODOs');
  });

  test('inlines skill content (no Skill(slug) directive, since Codex has no Skill tool)', () => {
    const doc = buildCodexInstructionDoc({
      rolePersona: 'Persona.',
      skillBundles: [
        { slug: 'gate-check', name: 'Gate Check', content: '# Gate Check\nRun gates locally until green.' },
        { slug: 'ui-audit', name: 'UI Audit', content: '# UI Audit\nEvaluate against UX heuristics.' },
      ],
    });
    // Skill content is inlined verbatim
    expect(doc).toContain('Run gates locally until green.');
    expect(doc).toContain('Evaluate against UX heuristics.');
    // Skill name shows up as a heading so the agent can tell them apart
    expect(doc).toContain('Gate Check');
    expect(doc).toContain('UI Audit');
    // It must NOT instruct invoking a Skill tool — that tool does not exist in Codex
    expect(doc).not.toContain('Skill(gate-check)');
    expect(doc).not.toContain('Skill tool');
  });

  test('skips skill bundles with empty content', () => {
    const doc = buildCodexInstructionDoc({
      skillBundles: [
        { slug: 'a', name: 'A', content: '' },
        { slug: 'b', name: 'B', content: 'Real instructions.' },
      ],
    });
    expect(doc).toContain('Real instructions.');
    // Empty skill produces no heading
    expect(doc).not.toContain('## Skill: A');
  });

  test('includes project CLAUDE.md content when provided', () => {
    const doc = buildCodexInstructionDoc({
      rolePersona: 'Persona.',
      skillBundles: [],
      projectInstructions: '# Project Rules\nAlways run bun test before finishing.',
    });
    expect(doc).toContain('Always run bun test before finishing.');
  });

  test('omits the project section when no CLAUDE.md is provided', () => {
    const doc = buildCodexInstructionDoc({ rolePersona: 'Persona.', skillBundles: [] });
    expect(doc).not.toContain('Project Instructions');
  });

  test('produces an empty doc when there is no persona, skills, or project instructions', () => {
    const doc = buildCodexInstructionDoc({ skillBundles: [] });
    expect(doc.trim().length).toBe(0);
  });
});

describe('writeCodexAgentsMd / restoreCodexAgentsMd', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-agents-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('creates AGENTS.md with the buildd section when none exists', async () => {
    const result = await writeCodexAgentsMd(dir, 'INSTRUCTION BODY');
    expect(result.existed).toBe(false);
    const p = join(dir, 'AGENTS.md');
    expect(await pathExists(p)).toBe(true);
    const content = await readFile(p, 'utf-8');
    expect(content).toContain('INSTRUCTION BODY');
    expect(content).toContain(BUILDD_AGENTS_BEGIN);
    expect(content).toContain(BUILDD_AGENTS_END);
  });

  test('appends a delimited section to an existing AGENTS.md without clobbering it', async () => {
    const p = join(dir, 'AGENTS.md');
    await writeFile(p, '# Existing repo AGENTS\nKeep this line.\n');
    const result = await writeCodexAgentsMd(dir, 'BUILDD BODY');
    expect(result.existed).toBe(true);

    const content = await readFile(p, 'utf-8');
    // Original content preserved
    expect(content).toContain('# Existing repo AGENTS');
    expect(content).toContain('Keep this line.');
    // buildd section appended and delimited
    expect(content).toContain(BUILDD_AGENTS_BEGIN);
    expect(content).toContain('BUILDD BODY');
    expect(content).toContain(BUILDD_AGENTS_END);
  });

  test('restore removes the buildd section but keeps the original file content when it pre-existed', async () => {
    const p = join(dir, 'AGENTS.md');
    const original = '# Existing repo AGENTS\nKeep this line.\n';
    await writeFile(p, original);
    const result = await writeCodexAgentsMd(dir, 'BUILDD BODY');

    await restoreCodexAgentsMd(dir, result);

    expect(await pathExists(p)).toBe(true);
    const content = await readFile(p, 'utf-8');
    expect(content).toContain('Keep this line.');
    expect(content).not.toContain('BUILDD BODY');
    expect(content).not.toContain(BUILDD_AGENTS_BEGIN);
  });

  test('restore deletes AGENTS.md entirely when buildd created it', async () => {
    const result = await writeCodexAgentsMd(dir, 'BUILDD BODY');
    expect(result.existed).toBe(false);
    await restoreCodexAgentsMd(dir, result);
    expect(await pathExists(join(dir, 'AGENTS.md'))).toBe(false);
  });

  test('re-writing replaces a stale buildd section instead of stacking duplicates', async () => {
    const p = join(dir, 'AGENTS.md');
    await writeFile(p, '# Existing\nline.\n');
    await writeCodexAgentsMd(dir, 'FIRST BODY');
    const second = await writeCodexAgentsMd(dir, 'SECOND BODY');
    expect(second.existed).toBe(true);
    const content = await readFile(p, 'utf-8');
    expect(content).toContain('SECOND BODY');
    expect(content).not.toContain('FIRST BODY');
    // Only one delimited section
    expect(content.split(BUILDD_AGENTS_BEGIN).length - 1).toBe(1);
    // Original preserved
    expect(content).toContain('# Existing');
  });

  test('restore is a no-op safe when the file was deleted out from under it', async () => {
    const result = await writeCodexAgentsMd(dir, 'BODY');
    await rm(join(dir, 'AGENTS.md'));
    await expect(restoreCodexAgentsMd(dir, result)).resolves.toBeUndefined();
  });
});

describe('Codex instruction block never reaches a commit', () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const { symlink, lstat, readlink } = require('fs/promises') as typeof import('fs/promises');
  let dir: string;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-leak-'));
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    // Git for Windows defaults: CRLF on checkout and symlinks checked out as
    // plain files. Pin the POSIX behaviour these tests assert.
    g('config', 'core.autocrlf', 'false');
    g('config', 'core.symlinks', 'true');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function committedText(): Promise<string> {
    g('add', '-A');
    try { g('commit', '-q', '-m', 'work', '--allow-empty'); } catch { /* nothing to commit */ }
    return g('log', '-p', '--all', '--format=');
  }

  test('AGENTS.md symlinked to CLAUDE.md: CLAUDE.md is untouched and nothing leaks', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), 'repo rules\n');
    await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
    g('add', '-A'); g('commit', '-q', '-m', 'base');

    const result = await writeCodexAgentsMd(dir, 'ROLE BLOCK');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toContain(BUILDD_AGENTS_BEGIN);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('repo rules\n');

    await writeFile(join(dir, 'feature.txt'), 'x\n');
    const patch = await committedText();
    expect(patch).not.toContain('BEGIN buildd agent instructions');
    expect(patch).toContain('feature.txt');

    await restoreCodexAgentsMd(dir, result);
    expect((await lstat(join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, 'AGENTS.md'))).toBe('CLAUDE.md');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('tracked regular AGENTS.md: block is hidden from commit -a and add -A', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'repo agents\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const result = await writeCodexAgentsMd(dir, 'ROLE BLOCK');
    await writeFile(join(dir, 'feature.txt'), 'x\n');
    expect(await committedText()).not.toContain('BEGIN buildd agent instructions');
    await restoreCodexAgentsMd(dir, result);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe('repo agents\n');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('no AGENTS.md in repo: new file is excluded, then removed with its exclude line', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const result = await writeCodexAgentsMd(dir, 'ROLE BLOCK');
    await writeFile(join(dir, 'feature.txt'), 'x\n');
    expect(await committedText()).not.toContain('BEGIN buildd agent instructions');
    await restoreCodexAgentsMd(dir, result);
    expect(await pathExists(join(dir, 'AGENTS.md'))).toBe(false);
    expect(await readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8')).not.toContain('/AGENTS.md');
  });
});

describe('Codex instruction block: review findings on restore', () => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const { symlink, lstat, readlink, mkdir } = require('fs/promises') as typeof import('fs/promises');
  let dir: string;
  const gi = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' });
  const g = (...a: string[]) => gi(dir, ...a);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-restore-'));
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    // Git for Windows defaults: CRLF on checkout and symlinks checked out as
    // plain files. Pin the POSIX behaviour these tests assert.
    g('config', 'core.autocrlf', 'false');
    g('config', 'core.symlinks', 'true');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function linkedRepo() {
    await writeFile(join(dir, 'CLAUDE.md'), 'repo rules\n');
    await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
    g('add', '-A'); g('commit', '-q', '-m', 'base');
  }
  const flag = () => g('ls-files', '-v', '--', 'AGENTS.md').trim().charAt(0);

  test('closing turn: nested write then inner and outer restore ends with the symlink and no flag', async () => {
    await linkedRepo();
    const outer = await writeCodexAgentsMd(dir, 'OUTER');
    const inner = await writeCodexAgentsMd(dir, 'INNER');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toContain('INNER');
    await restoreCodexAgentsMd(dir, inner);
    // Inner restore must not give the file back while the outer run owns it.
    expect(flag()).toBe('S');
    await restoreCodexAgentsMd(dir, outer);
    expect((await lstat(join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, 'AGENTS.md'))).toBe('CLAUDE.md');
    expect(flag()).toBe('H');
    expect(g('status', '--porcelain')).toBe('');
    g('add', '-A');
    expect(g('diff', '--cached', '--name-only')).toBe('');
  });

  test('restore is safe to call twice', async () => {
    await linkedRepo();
    const r = await writeCodexAgentsMd(dir, 'B');
    await restoreCodexAgentsMd(dir, r);
    await restoreCodexAgentsMd(dir, r);
    expect(g('status', '--porcelain')).toBe('');
  });

  test('crashed first run (regular file with the block, stale flag) is healed by a full second run', async () => {
    await linkedRepo();
    // State a killed runner leaves behind.
    await rm(join(dir, 'AGENTS.md'));
    await writeFile(join(dir, 'AGENTS.md'), `repo rules\n\n${BUILDD_AGENTS_BEGIN}\nOLD\n${BUILDD_AGENTS_END}\n`);
    g('update-index', '--skip-worktree', 'AGENTS.md');

    const r = await writeCodexAgentsMd(dir, 'NEW');
    const during = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
    expect(during.split(BUILDD_AGENTS_BEGIN).length - 1).toBe(1);
    expect(during).toContain('NEW');
    await restoreCodexAgentsMd(dir, r);

    expect((await lstat(join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect(flag()).toBe('H');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('crashed run on a tracked regular AGENTS.md restores the repo content, not the block', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'repo agents\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    await writeFile(join(dir, 'AGENTS.md'), `repo agents\n\n${BUILDD_AGENTS_BEGIN}\nOLD\n${BUILDD_AGENTS_END}\n`);
    g('update-index', '--skip-worktree', 'AGENTS.md');
    const r = await writeCodexAgentsMd(dir, 'NEW');
    await restoreCodexAgentsMd(dir, r);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe('repo agents\n');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('untracked: only this run\'s exclude line goes, other lines and blank lines stay, shared by linked worktrees', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const excl = join(dir, '.git', 'info', 'exclude');
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    const user = '# mine\n*.log\n\n\n\nscratch/\n';
    await writeFile(excl, user);
    const wt2 = join(dir, '..', `${basename(dir)}-wt2`);
    g('worktree', 'add', '-q', '-b', 'other', wt2);
    try {
      const r1 = await writeCodexAgentsMd(dir, 'ONE');
      const r2 = await writeCodexAgentsMd(wt2, 'TWO');
      expect((await readFile(excl, 'utf-8')).split('\n').filter((l) => l === '/AGENTS.md').length).toBe(1);
      await restoreCodexAgentsMd(dir, r1);
      // The other run is still live: its exclude line must survive.
      expect(await readFile(excl, 'utf-8')).toContain('/AGENTS.md');
      expect(gi(wt2, 'status', '--porcelain')).toBe('');
      await restoreCodexAgentsMd(wt2, r2);
      expect(await readFile(excl, 'utf-8')).toBe(user);
    } finally {
      g('worktree', 'remove', '--force', wt2);
    }
  });

  test('untracked: an exclude line the user already had is never removed', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const excl = join(dir, '.git', 'info', 'exclude');
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeFile(excl, '/AGENTS.md\n');
    const r = await writeCodexAgentsMd(dir, 'X');
    await restoreCodexAgentsMd(dir, r);
    expect(await readFile(excl, 'utf-8')).toBe('/AGENTS.md\n');
  });

  test('workers.ts restores before the closing-turn return and outside `if (session)`', async () => {
    const src = await readFile(join(__dirname, '../../src/workers.ts'), 'utf-8');
    const restore = src.indexOf('await restoreCodexAgentsMd(');
    expect(restore).toBeGreaterThan(0);
    expect(src.indexOf('await restoreCodexAgentsMd(', restore + 1)).toBe(-1);
    const early = src.indexOf('if (delegatedToClosingTurn) {\n        // The nested closing-turn call');
    expect(restore).toBeLessThan(early);
    const sessionIf = src.lastIndexOf('const session = this.sessions.get(worker.id);', restore);
    expect(sessionIf === -1 || sessionIf < src.lastIndexOf('cleanupSessionPromptFiles(worker.id);', restore)).toBe(true);
  });

  test('tracked AGENTS.md with no final newline comes back byte for byte', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'repo agents, no newline');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const r = await writeCodexAgentsMd(dir, 'B');
    await restoreCodexAgentsMd(dir, r);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe('repo agents, no newline');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('heals a stale skip-worktree flag from a killed run, for any backend', async () => {
    await linkedRepo();
    await rm(join(dir, 'AGENTS.md'));
    await writeFile(join(dir, 'AGENTS.md'), `${BUILDD_AGENTS_BEGIN}\nOLD\n${BUILDD_AGENTS_END}\n`);
    g('update-index', '--skip-worktree', 'AGENTS.md');
    await healStaleCodexAgentsMd(dir);
    expect((await lstat(join(dir, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect(flag()).toBe('H');
    expect(g('status', '--porcelain')).toBe('');
  });

  test('heal leaves a skip-worktree flag the user set on their own file', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'mine\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    g('update-index', '--skip-worktree', 'AGENTS.md');
    await writeFile(join(dir, 'AGENTS.md'), 'edited locally\n');
    await healStaleCodexAgentsMd(dir);
    expect(flag()).toBe('S');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf-8')).toBe('edited locally\n');
  });

  test('heals a stale marked exclude line, but never a bare line the user wrote', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const excl = join(dir, '.git', 'info', 'exclude');
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    const mark = '# added by buildd for the Codex AGENTS.md; safe to delete';
    await writeFile(excl, `*.log\n${mark}\n/AGENTS.md\n`);
    await healStaleCodexAgentsMd(dir);
    expect(await readFile(excl, 'utf-8')).toBe('*.log\n');
    await writeFile(excl, '*.log\n/AGENTS.md\n');
    await healStaleCodexAgentsMd(dir);
    expect(await readFile(excl, 'utf-8')).toBe('*.log\n/AGENTS.md\n');
  });

  test('a killed untracked run is healed by the next full run', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const excl = join(dir, '.git', 'info', 'exclude');
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeFile(excl, '# added by buildd for the Codex AGENTS.md; safe to delete\n/AGENTS.md\n');
    const r = await writeCodexAgentsMd(dir, 'X');
    await restoreCodexAgentsMd(dir, r);
    expect(await readFile(excl, 'utf-8')).toBe('');
  });
});
