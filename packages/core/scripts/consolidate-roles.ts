/**
 * One-off script: Consolidate ~20 fine-grained skills into ~5 broad roles.
 *
 * Usage:
 *   cd /Users/max/buildd && DATABASE_URL="..." bun scripts/consolidate-roles.ts
 *
 * Or if packages/core/config.ts reads from env automatically:
 *   cd /Users/max/buildd && bun scripts/consolidate-roles.ts
 *
 * What it does:
 *   1. Disables granular skills (keeps them for reference, doesn't delete)
 *   2. Creates/updates consolidated roles with rich instructions
 *
 * Safe to run multiple times — uses upsert on slug.
 */

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { workspaceSkills } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { config } from '../config';

const client = neon(config.databaseUrl);
const db = drizzle(client);

// ── Skills to disable (granular scripts that should become part of broader roles) ──

const SKILLS_TO_DISABLE = [
  'daily-digest',
  'daily-planner',
  'email-triage',
  'finance-monitor',
  'subscription-audit',
  'transaction-classifier',
  'buildd-features',
  'changelog-generator',
  'sdk-release-handler',
  'branch-cleanup',
  'sdk-ecosystem-research',
  'pipeline-sequential',
  'pipeline-release',
  'moa-ops-agent',
];

// ── Consolidated roles to create ──

interface RoleDef {
  slug: string;
  name: string;
  description: string;
  content: string;
  color: string;
  model: 'inherit' | 'sonnet' | 'opus' | 'haiku';
}

const CONSOLIDATED_ROLES: RoleDef[] = [
  {
    slug: 'builder',
    name: 'Builder',
    description: 'Core engineering — features, bug fixes, refactoring, releases',
    content: `# Builder

You are the Builder — the core engineering role. You ship features, fix bugs, refactor code, and manage releases.

## Responsibilities
- Implement new features and enhancements across the buildd monorepo
- Fix bugs with proper regression tests (TDD)
- Manage release pipelines (changelog, version bumps, deploy)
- Clean up branches and maintain repo hygiene
- Handle SDK releases and dependency updates

## Approach
- Follow the buildd-workflow: claim → plan → implement → test → ship
- Write tests first, code second
- Keep PRs focused — one concern per PR
- Use conventional commits (feat:, fix:, refactor:, etc.)
`,
    color: '#D4724A', // terracotta
    model: 'inherit',
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Research, analysis, ecosystem monitoring, competitive intelligence',
    content: `# Researcher

You are the Researcher — responsible for gathering intelligence, analyzing ecosystems, and surfacing insights.

## Responsibilities
- Monitor SDK ecosystems for relevant updates and breaking changes
- Research competitive landscape and market trends
- Analyze documentation and technical specifications
- Produce structured findings and recommendations

## Approach
- Be thorough but concise — surface what matters, skip noise
- Always cite sources and provide links
- Structure output as actionable insights, not raw data dumps
- Flag urgent findings (breaking changes, security issues) immediately
`,
    color: '#D97706', // amber
    model: 'inherit',
  },
  {
    slug: 'ops',
    name: 'Ops',
    description: 'Infrastructure, pipelines, monitoring, deployment operations',
    content: `# Ops

You are Ops — responsible for infrastructure, CI/CD pipelines, monitoring, and operational tasks.

## Responsibilities
- Manage and maintain CI/CD pipelines (sequential, release, preview)
- Monitor infrastructure health and performance
- Handle deployment operations and rollbacks
- Manage MoA (Mixture of Agents) operations and coordination
- Maintain operational runbooks and incident response

## Approach
- Safety first — always verify before destructive operations
- Use idempotent operations where possible
- Document changes to infrastructure and pipelines
- Alert on anomalies, don't wait for failures
`,
    color: '#2C8C99', // teal
    model: 'inherit',
  },
  {
    slug: 'finance',
    name: 'Finance',
    description: 'Financial monitoring, audits, transaction classification, compliance',
    content: `# Finance

You are Finance — responsible for financial monitoring, audits, and compliance.

## Responsibilities
- Monitor financial metrics and flag anomalies
- Audit subscriptions and recurring charges
- Classify transactions and maintain categorization rules
- Generate financial summaries and reports
- Flag compliance issues

## Approach
- Be precise with numbers — double-check calculations
- Flag anomalies early with clear severity levels
- Maintain audit trails for all financial decisions
- Structure output for easy review (tables, summaries)
`,
    color: '#6B8E5E', // olive green
    model: 'inherit',
  },
  {
    slug: 'comms',
    name: 'Comms',
    description: 'Email triage, daily digests, briefings, and communications',
    content: `# Comms

You are Comms — responsible for communications, briefings, and information synthesis.

## Responsibilities
- Triage and prioritize incoming emails
- Produce daily digests and planning summaries
- Draft communications and status updates
- Synthesize information across sources into briefings

## Approach
- Lead with what's actionable, then context
- Keep digests scannable — bullet points, not paragraphs
- Prioritize by urgency and impact
- Flag items that need human decision-making
`,
    color: '#5B7BB3', // steel blue
    model: 'inherit',
  },
];

async function main() {
  console.log('Consolidating roles...\n');

  // Step 1: Find all workspaces that have skills to disable
  const existingSkills = await db
    .select({ workspaceId: workspaceSkills.workspaceId, slug: workspaceSkills.slug, id: workspaceSkills.id, enabled: workspaceSkills.enabled })
    .from(workspaceSkills)
    .where(inArray(workspaceSkills.slug, SKILLS_TO_DISABLE));

  const workspaceIds = [...new Set(existingSkills.map(s => s.workspaceId))];
  console.log(`Found ${existingSkills.length} skills to disable across ${workspaceIds.length} workspace(s)`);

  // Step 2: Disable granular skills
  if (existingSkills.length > 0) {
    const enabledIds = existingSkills.filter(s => s.enabled).map(s => s.id);
    if (enabledIds.length > 0) {
      await db
        .update(workspaceSkills)
        .set({ enabled: false, updatedAt: new Date() })
        .where(inArray(workspaceSkills.id, enabledIds));
      console.log(`Disabled ${enabledIds.length} granular skills`);
    } else {
      console.log('All granular skills already disabled');
    }
  }

  // Step 3: Create consolidated roles in each workspace
  for (const wsId of workspaceIds) {
    console.log(`\nWorkspace ${wsId}:`);

    for (const role of CONSOLIDATED_ROLES) {
      const contentHash = new Bun.CryptoHasher('sha256').update(role.content).digest('hex');

      // Upsert by slug
      const existing = await db
        .select({ id: workspaceSkills.id })
        .from(workspaceSkills)
        .where(and(
          eq(workspaceSkills.workspaceId, wsId),
          eq(workspaceSkills.slug, role.slug),
        ))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(workspaceSkills)
          .set({
            name: role.name,
            description: role.description,
            content: role.content,
            contentHash,
            color: role.color,
            model: role.model,
            enabled: true,
            updatedAt: new Date(),
          })
          .where(eq(workspaceSkills.id, existing[0].id));
        console.log(`  Updated: ${role.name} (${role.slug})`);
      } else {
        await db.insert(workspaceSkills).values({
          id: crypto.randomUUID(),
          workspaceId: wsId,
          slug: role.slug,
          name: role.name,
          description: role.description,
          content: role.content,
          contentHash,
          source: 'consolidation-script',
          enabled: true,
          origin: 'manual',
          metadata: {},
          color: role.color,
          model: role.model,
          allowedTools: [],
          canDelegateTo: [],
          background: false,
          maxTurns: null,
          mcpServers: [],
          requiredEnvVars: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  Created: ${role.name} (${role.slug})`);
      }
    }
  }

  console.log('\nDone! Your Team page should now show 5 focused roles.');
  console.log('Old skills are disabled (not deleted) — you can re-enable or delete them from the UI.');
  process.exit(0);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
