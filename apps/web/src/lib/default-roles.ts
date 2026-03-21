/**
 * Default roles seeded into new workspaces.
 *
 * Tier 1: Builder + Researcher — useful immediately for any workspace.
 * MCP configs use ${VAR} interpolation; users store secrets via /api/secrets
 * with purpose='mcp_credential' and matching labels.
 */

import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { createHash } from 'crypto';

const BUILDD_MCP = {
  type: 'http',
  url: 'https://buildd.dev/api/mcp',
  headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' },
};

interface DefaultRole {
  slug: string;
  name: string;
  description: string;
  content: string;
  color: string;
  model: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  isRole: true;
  allowedTools: string[];
  canDelegateTo: string[];
  mcpServers: Record<string, unknown>;
  requiredEnvVars: Record<string, string>;
}

const DEFAULT_ROLES: DefaultRole[] = [
  {
    slug: 'builder',
    name: 'Builder',
    description: 'Core engineering — features, bug fixes, refactoring, releases',
    content: `# Builder

You are the Builder — the core engineering role. You ship features, fix bugs, refactor code, and manage releases.

## Responsibilities
- Implement new features and enhancements
- Fix bugs with proper regression tests (TDD — tests first, code second)
- Manage release pipelines (changelog, version bumps, deploy)
- Handle dependency updates and repo hygiene

## Approach
- Follow the buildd workflow: claim → plan → implement → test → ship
- Write tests first, code second
- Keep PRs focused — one concern per PR
- Use conventional commits (feat:, fix:, refactor:, etc.)
- Use the buildd MCP to report progress and create artifacts
`,
    color: '#D4724A',
    model: 'inherit',
    isRole: true,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch', 'NotebookEdit'],
    canDelegateTo: ['researcher'],
    mcpServers: { buildd: BUILDD_MCP },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key' },
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Research, analysis, ecosystem monitoring, competitive intelligence',
    content: `# Researcher

You are the Researcher — responsible for gathering intelligence, analyzing ecosystems, and surfacing insights.

## Responsibilities
- Research technical topics, APIs, and documentation
- Monitor SDK ecosystems for relevant updates and breaking changes
- Analyze competitive landscape and market trends
- Produce structured findings and recommendations

## Approach
- Be thorough but concise — surface what matters, skip noise
- Always cite sources and provide links
- Structure output as actionable insights, not raw data dumps
- Flag urgent findings (breaking changes, security issues) immediately
- Use the buildd MCP to report progress and create artifacts
`,
    color: '#D97706',
    model: 'inherit',
    isRole: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    canDelegateTo: ['builder'],
    mcpServers: { buildd: BUILDD_MCP },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key' },
  },
];

/**
 * Seed Tier 1 default roles into a newly created workspace.
 * Safe to call multiple times — uses onConflictDoNothing on (workspaceId, slug).
 */
export async function seedDefaultRoles(workspaceId: string): Promise<void> {
  const now = new Date();

  await db.insert(workspaceSkills)
    .values(DEFAULT_ROLES.map(role => ({
      id: crypto.randomUUID(),
      workspaceId,
      slug: role.slug,
      name: role.name,
      description: role.description,
      content: role.content,
      contentHash: createHash('sha256').update(role.content).digest('hex'),
      source: 'system',
      enabled: true,
      origin: 'manual' as const,
      metadata: {},
      color: role.color,
      model: role.model,
      isRole: role.isRole,
      allowedTools: role.allowedTools,
      canDelegateTo: role.canDelegateTo,
      background: false,
      maxTurns: null,
      mcpServers: role.mcpServers,
      requiredEnvVars: role.requiredEnvVars,
      createdAt: now,
      updatedAt: now,
    })))
    .onConflictDoNothing();
}
