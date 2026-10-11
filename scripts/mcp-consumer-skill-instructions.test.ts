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

// The block is built by mcpServerInstructions (apps/web/src/app/api/mcp/tools.ts)
// per token level and tool surface; check every combination.
const LEVELS = ['trigger', 'worker', 'admin'] as const;
const SURFACES = ['groups', 'legacy'] as const;
async function allInstructions(): Promise<Array<{ level: string; surface: string; text: string }>> {
  const { mcpServerInstructions } = await import('../apps/web/src/app/api/mcp/tools');
  return LEVELS.flatMap(level => SURFACES.map(surface => ({ level, surface, text: mcpServerInstructions(level, surface) })));
}

describe('MCP server instructions block', () => {
  it('route.ts sends the shared instructions', () => {
    expect(routeSource).toContain('instructions: mcpServerInstructions(accountLevel, toolSurface, tokenScopes, { principal, orchestrationTaskToken })');
  });

  it('is under the size that was observed truncating', async () => {
    for (const { level, surface, text } of await allInstructions()) {
      expect(text.length, `${level}/${surface}`).toBeLessThan(MAX_INSTRUCTIONS_CHARS);
    }
  });

  it('still carries what a client needs before its first tool call', async () => {
    for (const { level, text } of await allInstructions()) {
      // Token level + what a 403 means — the resident guarantee
      // mcp-action-contracts.md AC-3 documents.
      expect(text).toContain(`**Token level:** ${level}`);
      expect(text).toContain('forbidden');
      // The pointer to the skill, and the resource fallback for a client with
      // none installed — the thing that makes the pointer's promise true.
      expect(text).toContain('buildd-mcp-consumer');
      expect(text).toContain('buildd://workspace/skills');
    }
  });

  it('no longer inlines the full worker lifecycle', async () => {
    for (const { text } of await allInstructions()) {
      // These moved to the skill body — their presence here would mean the
      // split didn't actually happen.
      expect(text).not.toContain('milestones');
      expect(text).not.toContain('AskUserQuestion');
      expect(text).not.toContain('frictionSignature');
    }
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

describe('buildd://workspace/onboarding resource', () => {
  // docs/design/workspace-onboarding.md section 5 / AC-14: the resource serves
  // the committed skill file itself, read at request time, never a copy.
  const skillRelPath = '.claude/skills/workspace-onboarding/SKILL.md';
  const nextConfig = readFileSync(join(repoRoot, 'apps/web/next.config.mjs'), 'utf8');

  it('is listed and read from the one skill file at request time', () => {
    expect(routeSource).toContain('uri: "buildd://workspace/onboarding"');
    expect(routeSource).toContain('case "buildd://workspace/onboarding"');
    expect(routeSource).toContain('readOnboardingSkillBody');
    expect(routeSource).toContain('workspace-onboarding');
    // Beside, not instead of, the consumer skill resource.
    expect(routeSource).toContain('case "buildd://workspace/skills"');
  });

  it('is force-included in the serverless bundle for /api/mcp', () => {
    expect(nextConfig).toContain('../../.claude/skills/workspace-onboarding/**');
    expect(nextConfig).toContain('../../.claude/skills/buildd-mcp-consumer/**');
  });

  it('resolves, from the route\'s working directory, to exactly the committed file', () => {
    // The route builds its path as join(process.cwd(), "..", "..", ".claude",
    // "skills", "workspace-onboarding", "SKILL.md") with cwd = apps/web.
    expect(routeSource).toMatch(
      /join\(\s*process\.cwd\(\),\s*"\.\.",\s*"\.\.",\s*"\.claude",\s*"skills",\s*"workspace-onboarding",\s*"SKILL\.md"\s*\)/,
    );
    const resolved = join(repoRoot, 'apps/web', '..', '..', '.claude', 'skills', 'workspace-onboarding', 'SKILL.md');
    expect(resolved).toBe(join(repoRoot, skillRelPath));
    expect(readFileSync(resolved, 'utf8')).toBe(readFileSync(join(repoRoot, skillRelPath), 'utf8'));
  });

  it('has no inlined copy of the skill body in the route', () => {
    const body = readFileSync(join(repoRoot, skillRelPath), 'utf8');
    const distinctiveLine = body.split('\n').find(l => l.length > 60 && !l.startsWith('---')) ?? '';
    expect(distinctiveLine.length).toBeGreaterThan(0);
    expect(routeSource).not.toContain(distinctiveLine);
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
