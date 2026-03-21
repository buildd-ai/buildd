/**
 * One-off script: Wire MCP servers, tool restrictions, and delegation rules
 * into existing roles, and create the Chief of Staff role.
 *
 * Usage:
 *   cd /Users/max/buildd/packages/core && bun scripts/seed-role-mcps.ts
 *
 * Safe to run multiple times — uses upsert on (workspaceId, slug).
 */

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { workspaceSkills } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { config } from '../config';
import { createHash } from 'crypto';

const client = neon(config.databaseUrl);
const db = drizzle(client);

// ── MCP Server Templates (using ${VAR} interpolation for secrets) ──

const MCPS = {
  buildd: {
    type: 'http',
    url: 'https://buildd.dev/api/mcp',
    headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' },
  },
  dispatch: {
    type: 'http',
    url: 'https://dispatch.buildd.dev/api/mcp',
    headers: { 'x-api-key': '${DISPATCH_API_KEY}' },
  },
  'moa-ops': {
    type: 'http',
    url: 'https://moa-ops.vercel.app/api/mcp',
    headers: { Authorization: 'Bearer ${MOA_OPS_API_KEY}' },
  },
  'moa-ops-finance': {
    type: 'http',
    url: 'https://moa-ops.vercel.app/api/mcp/finance',
    headers: { Authorization: 'Bearer ${MOA_OPS_API_KEY}' },
  },
};

// ── Role Configurations ──

interface RoleUpdate {
  slug: string;
  mcpServers: Record<string, unknown>;
  requiredEnvVars: Record<string, string>;
  allowedTools: string[];
  canDelegateTo: string[];
}

const ROLE_UPDATES: RoleUpdate[] = [
  {
    slug: 'builder',
    mcpServers: { buildd: MCPS.buildd },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key' },
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch', 'NotebookEdit'],
    canDelegateTo: ['researcher'],
  },
  {
    slug: 'researcher',
    mcpServers: { buildd: MCPS.buildd, dispatch: MCPS.dispatch },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key', DISPATCH_API_KEY: 'dispatch-api-key' },
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    canDelegateTo: ['builder'],
  },
  {
    slug: 'ops',
    mcpServers: { buildd: MCPS.buildd, 'moa-ops': MCPS['moa-ops'] },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key', MOA_OPS_API_KEY: 'moa-ops-api-key' },
    allowedTools: [], // all tools
    canDelegateTo: ['builder'],
  },
  {
    slug: 'finance',
    mcpServers: { buildd: MCPS.buildd, 'moa-ops-finance': MCPS['moa-ops-finance'], dispatch: MCPS.dispatch },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key', MOA_OPS_API_KEY: 'moa-ops-api-key', DISPATCH_API_KEY: 'dispatch-api-key' },
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent'],
    canDelegateTo: [],
  },
  {
    slug: 'comms',
    mcpServers: { buildd: MCPS.buildd, dispatch: MCPS.dispatch },
    requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key', DISPATCH_API_KEY: 'dispatch-api-key' },
    allowedTools: ['Read', 'WebSearch', 'WebFetch', 'Agent'],
    canDelegateTo: [],
  },
];

// ── Chief of Staff (new role) ──

const CHIEF_OF_STAFF = {
  slug: 'chief-of-staff',
  name: 'Chief of Staff',
  description: 'Triage, delegation, day planning, inbox management — your AI representative',
  content: `# Chief of Staff

You are the Chief of Staff — the delegation hub and personal representative. You triage incoming work, plan the day, manage communications, and route tasks to the right roles.

## Responsibilities
- Triage incoming emails, messages, and notifications via dispatch
- Plan and prioritize the day's work across all roles
- Create and assign tasks to the right roles via buildd
- Monitor progress across active work and flag blockers
- Synthesize status updates and daily briefings
- Make scheduling decisions (calendar, meetings, deadlines)

## Approach
- Start by checking dispatch for new emails, calendar events, and pending items
- Check buildd for active tasks, blocked workers, and pending reviews
- Prioritize by urgency and impact — flag items needing human decision
- Delegate to specialized roles: builder for code, researcher for analysis, ops for infra, finance for money, comms for writing
- Keep briefings scannable — bullet points, not paragraphs
- When in doubt about priority or delegation, ask rather than guess

## Delegation Guide
- **builder**: Features, bug fixes, PRs, code changes
- **researcher**: Analysis, ecosystem monitoring, competitive intel, documentation research
- **ops**: CI/CD, infrastructure, monitoring, deployments
- **finance**: Financial monitoring, audits, subscription tracking
- **comms**: Email drafts, digests, status updates, communications
`,
  color: '#C4963B',
  model: 'inherit' as const,
  isRole: true,
  mcpServers: { buildd: MCPS.buildd, dispatch: MCPS.dispatch },
  requiredEnvVars: { BUILDD_API_KEY: 'buildd-api-key', DISPATCH_API_KEY: 'dispatch-api-key' },
  allowedTools: ['Read', 'WebSearch', 'WebFetch', 'Agent'],
  canDelegateTo: ['builder', 'researcher', 'ops', 'finance', 'comms'],
  background: false,
  maxTurns: null,
};

async function main() {
  console.log('Wiring MCP servers into roles...\n');

  // Find all workspaces that have the existing roles
  const existingRoles = await db
    .select({ workspaceId: workspaceSkills.workspaceId, slug: workspaceSkills.slug, id: workspaceSkills.id })
    .from(workspaceSkills)
    .where(eq(workspaceSkills.isRole, true));

  const workspaceIds = [...new Set(existingRoles.map(r => r.workspaceId))];
  console.log(`Found ${existingRoles.length} roles across ${workspaceIds.length} workspace(s)\n`);

  // Update existing roles with MCP configs
  for (const wsId of workspaceIds) {
    console.log(`Workspace ${wsId}:`);

    for (const update of ROLE_UPDATES) {
      const existing = existingRoles.find(r => r.workspaceId === wsId && r.slug === update.slug);
      if (!existing) {
        console.log(`  Skipped: ${update.slug} (not found)`);
        continue;
      }

      await db
        .update(workspaceSkills)
        .set({
          mcpServers: update.mcpServers,
          requiredEnvVars: update.requiredEnvVars,
          allowedTools: update.allowedTools,
          canDelegateTo: update.canDelegateTo,
          updatedAt: new Date(),
        })
        .where(eq(workspaceSkills.id, existing.id));

      const mcpNames = Object.keys(update.mcpServers).join(', ');
      console.log(`  Updated: ${update.slug} → MCPs: [${mcpNames}], Tools: ${update.allowedTools.length || 'all'}, Delegates: [${update.canDelegateTo.join(', ')}]`);
    }

    // Create or update Chief of Staff
    const existingCos = await db
      .select({ id: workspaceSkills.id })
      .from(workspaceSkills)
      .where(and(
        eq(workspaceSkills.workspaceId, wsId),
        eq(workspaceSkills.slug, CHIEF_OF_STAFF.slug),
      ))
      .limit(1);

    const contentHash = createHash('sha256').update(CHIEF_OF_STAFF.content).digest('hex');

    if (existingCos.length > 0) {
      await db
        .update(workspaceSkills)
        .set({
          name: CHIEF_OF_STAFF.name,
          description: CHIEF_OF_STAFF.description,
          content: CHIEF_OF_STAFF.content,
          contentHash,
          color: CHIEF_OF_STAFF.color,
          model: CHIEF_OF_STAFF.model,
          isRole: CHIEF_OF_STAFF.isRole,
          mcpServers: CHIEF_OF_STAFF.mcpServers,
          requiredEnvVars: CHIEF_OF_STAFF.requiredEnvVars,
          allowedTools: CHIEF_OF_STAFF.allowedTools,
          canDelegateTo: CHIEF_OF_STAFF.canDelegateTo,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(workspaceSkills.id, existingCos[0].id));
      console.log(`  Updated: chief-of-staff`);
    } else {
      await db.insert(workspaceSkills).values({
        id: crypto.randomUUID(),
        workspaceId: wsId,
        slug: CHIEF_OF_STAFF.slug,
        name: CHIEF_OF_STAFF.name,
        description: CHIEF_OF_STAFF.description,
        content: CHIEF_OF_STAFF.content,
        contentHash,
        source: 'seed-script',
        enabled: true,
        origin: 'manual',
        metadata: {},
        color: CHIEF_OF_STAFF.color,
        model: CHIEF_OF_STAFF.model,
        isRole: CHIEF_OF_STAFF.isRole,
        mcpServers: CHIEF_OF_STAFF.mcpServers,
        requiredEnvVars: CHIEF_OF_STAFF.requiredEnvVars,
        allowedTools: CHIEF_OF_STAFF.allowedTools,
        canDelegateTo: CHIEF_OF_STAFF.canDelegateTo,
        background: false,
        maxTurns: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`  Created: chief-of-staff`);
    }
  }

  console.log('\nDone! Roles now have MCP servers, tool restrictions, and delegation rules.');
  console.log('\nReminder: Ensure these secrets exist in the secrets table with purpose=\'mcp_credential\':');
  console.log('  - label: buildd-api-key');
  console.log('  - label: dispatch-api-key');
  console.log('  - label: moa-ops-api-key');
  process.exit(0);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
