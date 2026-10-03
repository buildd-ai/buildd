import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ONBOARDING_INTERVIEW } from '../packages/shared/src/onboarding-interview';

/**
 * Content gate for `.claude/skills/workspace-onboarding/SKILL.md`
 * (docs/design/workspace-onboarding.md section 5, AC-13/AC-14). The skill is a
 * second written form of three things the code owns: the readiness checklist,
 * the interview, and the approval rules. Each is resolved against its source
 * here so the prose cannot drift from what the server does.
 */

const repoRoot = join(__dirname, '..');
const MAX_SKILL_BYTES = 8 * 1024;
const body = readFileSync(join(repoRoot, '.claude/skills/workspace-onboarding/SKILL.md'), 'utf8');

/** Union members of `export type <name> =` in a source file. */
function unionMembers(file: string, typeName: string): string[] {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  const m = new RegExp(`export type ${typeName} =([^;]+);`).exec(src);
  if (!m) throw new Error(`type ${typeName} not found in ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('workspace-onboarding skill', () => {
  it('has skill frontmatter naming itself and says when to load it', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
    expect(fm).not.toBeNull();
    expect(fm![1]).toMatch(/^name: workspace-onboarding$/m);
    expect(fm![1]).toMatch(/^description: ".+"$/m);
  });

  it('stays within the 8 KB budget', () => {
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES);
  });

  it('lists the steps in order', () => {
    const order = ['create workspace', 'link', 'init', 'readiness', 'scaffold', 'author_spec', 'manage_missions'];
    const lower = body.toLowerCase();
    let from = 0;
    for (const word of order) {
      const at = lower.indexOf(word, from);
      expect(at, `step "${word}" after offset ${from}`).toBeGreaterThanOrEqual(0);
      from = at;
    }
  });

  it('names every readiness item id, fix kind and next step the report can return', () => {
    const ids = unionMembers('packages/core/readiness/types.ts', 'ReadinessItemId');
    const fixKinds = unionMembers('packages/core/readiness/types.ts', 'FixKind');
    const nextSteps = unionMembers('packages/core/readiness/types.ts', 'ReadinessNextStep');
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(body, `item ${id}`).toContain(`\`${id}\``);
    for (const k of fixKinds.filter(k => k !== 'none')) expect(body, `fix kind ${k}`).toContain(`\`${k}\``);
    for (const s of nextSteps) expect(body, `nextStep ${s}`).toContain(`\`${s}\``);
  });

  it('carries every interview question verbatim, in the shared order, with its mapping', () => {
    let from = 0;
    for (const q of ONBOARDING_INTERVIEW) {
      const row = body.split('\n').find(l => l.startsWith(`| ${q.id} |`));
      expect(row, `${q.id} row`).toBeDefined();
      expect(row!, `${q.id} prompt`).toContain(q.prompt);
      expect(row!, `${q.id} answer field`).toContain(`\`${q.answerField}\``);
      expect(row!, `${q.id} target`).toContain(q.target);
      const at = body.indexOf(row!);
      expect(at).toBeGreaterThan(from);
      from = at;
    }
  });

  it('states the two approval points and the dry-run defaults', () => {
    expect(body).toMatch(/approval/i);
    expect(body).toMatch(/dryRun/);
    expect(body).toContain('confirm: true');
    expect(body).toMatch(/no `itemIds`|without `itemIds`/i);
    expect(body).toMatch(/human merges|owner merges/i);
  });

  it('states the two hard rules', () => {
    expect(body).toMatch(/never commit to the default branch/i);
    expect(body).toMatch(/never require vercel/i);
    expect(body).toMatch(/never auto-merge/i);
  });

  it('points the readiness-driven flow at the right tool and keeps init standalone', () => {
    expect(body).toContain('manage_workspaces');
    expect(body).toContain('action: "init"');
  });
});

describe('buildd-mcp-consumer skill pointer', () => {
  const consumer = readFileSync(join(repoRoot, '.claude/skills/buildd-mcp-consumer/SKILL.md'), 'utf8');

  it('has exactly one pointer line to workspace-onboarding and the resource fallback', () => {
    const lines = consumer.split('\n').filter(l => l.includes('workspace-onboarding'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('buildd://workspace/onboarding');
  });

  it('is mirrored byte-for-byte in the scaffolded consumer-skill template', () => {
    const template = readFileSync(join(repoRoot, 'packages/core/onboarding-templates/consumer-skill.md'), 'utf8');
    expect(template).toBe(consumer);
  });
});
