import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexInstructionDoc,
  writeCodexAgentsMd,
  restoreCodexAgentsMd,
  BUILDD_AGENTS_BEGIN,
  BUILDD_AGENTS_END,
} from '../../src/codex-instructions';
import { buildCbmGuidanceBody } from '../../src/cbm-enforcement';

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

  test('produces an empty doc when there is no persona, skills, project instructions, or CBM guidance', () => {
    const doc = buildCodexInstructionDoc({ skillBundles: [] });
    expect(doc.trim().length).toBe(0);
  });

  test('carries the codebase-graph guidance when CBM is mounted for this task', () => {
    // AGENTS.md is Codex's only standing-instruction channel: no systemPrompt
    // seam, and (through the SDK) no hook seam either. CBM was mounted but
    // unmentioned on Claude once, and every worker then ignored it.
    const doc = buildCodexInstructionDoc({
      skillBundles: [],
      cbmGuidance: buildCbmGuidanceBody({ dialect: 'codex' }),
    });
    expect(doc).toContain('# Codebase graph (codebase-memory)');
    expect(doc).toContain('make a graph call your FIRST navigation step');
    expect(doc).toContain('mcp__codebase-memory__get_architecture');
    // Codex has no Read/Grep/Glob tools — naming them would describe tools it
    // does not have, the same class of error as describing an absent server.
    expect(doc).not.toContain('Read/Grep/Glob');
  });

  test('omits the graph section entirely when CBM is not mounted', () => {
    const doc = buildCodexInstructionDoc({ skillBundles: [] });
    expect(doc).not.toContain('Codebase graph');
    expect(doc).not.toContain('codebase-memory');
  });

  test('the graph section follows the project instructions section', () => {
    const doc = buildCodexInstructionDoc({
      skillBundles: [],
      projectInstructions: '# Project Rules\nAlways run bun test before finishing.',
      cbmGuidance: buildCbmGuidanceBody({ dialect: 'codex' }),
    });
    expect(doc.indexOf('Project Instructions')).toBeLessThan(doc.indexOf('# Codebase graph'));
  });
});

describe('writeCodexAgentsMd / restoreCodexAgentsMd', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-agents-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
