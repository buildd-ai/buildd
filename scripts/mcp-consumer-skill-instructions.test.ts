import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guards the split decided in docs/design/buildd-mcp-consumer-skill.md: the
 * MCP server's `instructions` block was ~2,437 chars (~609 tokens) and was
 * observed truncating mid-connection. Everything procedural moved out to
 * `.claude/skills/buildd-mcp-consumer/SKILL.md`; `instructions` keeps only
 * identity, token level, and a pointer. A future edit that quietly grows
 * `instructions` back into a lifecycle guide reintroduces the truncation
 * this split exists to fix — this test is the size gate that catches it.
 *
 * The proposed replacement text was ~709 chars (~177 tokens). The threshold
 * below is 1,200 chars: comfortably clear of the proposal (room to reword)
 * while still roughly half of what was truncating.
 */
const MAX_INSTRUCTIONS_CHARS = 1200;

const repoRoot = join(__dirname, '..');
const routeSource = readFileSync(
  join(repoRoot, 'apps/web/src/app/api/mcp/route.ts'),
  'utf8',
);

function extractInstructionsTemplate(source: string): string {
  const marker = 'instructions: `';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + marker.length;
  const end = source.indexOf('`,\n    }\n  );', bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, end);
}

describe('MCP server instructions block', () => {
  it('is under the size that was observed truncating', () => {
    const instructions = extractInstructionsTemplate(routeSource);
    expect(instructions.length).toBeLessThan(MAX_INSTRUCTIONS_CHARS);
  });

  it('still carries what a client needs before its first tool call', () => {
    const instructions = extractInstructionsTemplate(routeSource);
    // Token level + what a 403 means — the resident guarantee
    // mcp-action-contracts.md AC-3 documents.
    expect(instructions).toContain('${accountLevel}');
    expect(instructions).toContain('forbidden');
    // The pointer to the skill, and the resource fallback for a client with
    // none installed — the thing that makes the pointer's promise true.
    expect(instructions).toContain('buildd-mcp-consumer');
    expect(instructions).toContain('buildd://workspace/skills');
  });

  it('no longer inlines the full worker lifecycle', () => {
    const instructions = extractInstructionsTemplate(routeSource);
    // These moved to the skill body — their presence here would mean the
    // split didn't actually happen.
    expect(instructions).not.toContain('milestones');
    expect(instructions).not.toContain('AskUserQuestion');
    expect(instructions).not.toContain('frictionSignature');
  });
});

describe('buildd://workspace/skills resource', () => {
  it('serves the skill file content, not a placeholder', () => {
    expect(routeSource).not.toContain(
      'Provide workspaceId in tool params to access workspace-scoped resources.',
    );
    expect(routeSource).toContain('readConsumerSkillBody');
    expect(routeSource).toContain('buildd-mcp-consumer/SKILL.md');
  });
});

describe('a skill-less client can still work a task from what remains', () => {
  // The trimmed instructions block drops per-action parameter detail on the
  // assumption that each tool's own schema description already carries it
  // (buildParamsDescription in packages/core/mcp-tools.ts). If that
  // assumption were false, a client with no skill installed couldn't call
  // these three actions correctly — the trim would have gone too far.
  it("create_task's own description states its required fields", async () => {
    const { buildParamsDescription } = await import('../packages/core/mcp-tools');
    const desc = buildParamsDescription(['create_task']);
    expect(desc).toContain('title (required)');
    expect(desc).toContain('description (required)');
  });

  it('claim_task and complete_task are callable with no required params', async () => {
    const { buildParamsDescription } = await import('../packages/core/mcp-tools');
    const claimDesc = buildParamsDescription(['claim_task']);
    const completeDesc = buildParamsDescription(['complete_task']);
    expect(claimDesc).not.toContain('(required)');
    expect(completeDesc).not.toContain('(required)');
  });
});
