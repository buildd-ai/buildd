#!/usr/bin/env bun
/**
 * Migration script: Export existing observations from buildd DB → memory service.
 *
 * Reads observations from the buildd Postgres database and writes them
 * to the memory service, mapping:
 *   - workspace repo/name → memory `project`
 *   - observations.concepts → memory `tags`
 *   - observations.workerId → memory `source` (as "worker:<id>")
 *   - All other fields map directly
 *
 * Usage:
 *   DATABASE_URL=... MEMORY_API_URL=... MEMORY_API_KEY=... bun run scripts/migrate-observations-to-memory.ts
 *
 * Options:
 *   --dry-run     Print what would be migrated without writing
 *   --workspace   Only migrate a specific workspace ID
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
const MEMORY_API_URL = process.env.MEMORY_API_URL;
const MEMORY_API_KEY = process.env.MEMORY_API_KEY;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const workspaceArg = args.find(a => a.startsWith('--workspace='))?.split('=')[1];

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (!dryRun && (!MEMORY_API_URL || !MEMORY_API_KEY)) {
  console.error('MEMORY_API_URL and MEMORY_API_KEY are required (or use --dry-run)');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

interface Observation {
  id: string;
  workspace_id: string;
  worker_id: string | null;
  task_id: string | null;
  type: string;
  title: string;
  content: string;
  files: string[];
  concepts: string[];
  project: string | null;
  created_at: string;
}

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
}

async function saveToMemoryService(memory: {
  type: string;
  title: string;
  content: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${MEMORY_API_URL}/api/memories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MEMORY_API_KEY!,
    },
    body: JSON.stringify(memory),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Memory API ${res.status}: ${body}`);
  }

  const data = await res.json();
  return { id: data.memory.id };
}

async function main() {
  console.log(dryRun ? '=== DRY RUN ===' : '=== MIGRATING ===');
  console.log();

  // Fetch all workspaces for project mapping
  const workspaceQuery = workspaceArg
    ? `SELECT id, name, repo FROM workspaces WHERE id = '${workspaceArg}'`
    : 'SELECT id, name, repo FROM workspaces';

  const workspaces = await sql(workspaceQuery) as Workspace[];
  const wsMap = new Map(workspaces.map(ws => [ws.id, ws]));

  console.log(`Found ${workspaces.length} workspace(s)`);

  // Fetch all observations
  const obsQuery = workspaceArg
    ? `SELECT * FROM observations WHERE workspace_id = '${workspaceArg}' ORDER BY created_at ASC`
    : 'SELECT * FROM observations ORDER BY created_at ASC';

  const observations = await sql(obsQuery) as Observation[];
  console.log(`Found ${observations.length} observation(s) to migrate`);
  console.log();

  let migrated = 0;
  let failed = 0;

  for (const obs of observations) {
    const ws = wsMap.get(obs.workspace_id);
    const project = ws?.repo || ws?.name || obs.workspace_id;
    const source = obs.worker_id ? `worker:${obs.worker_id}` : 'migrated';

    const memory = {
      type: obs.type,
      title: obs.title,
      content: obs.content,
      project,
      tags: obs.concepts || [],
      files: obs.files || [],
      source,
    };

    if (dryRun) {
      console.log(`  [${obs.type}] ${obs.title}`);
      console.log(`    project: ${project}, tags: ${(obs.concepts || []).join(', ')}, files: ${(obs.files || []).length}`);
      migrated++;
      continue;
    }

    try {
      const result = await saveToMemoryService(memory);
      console.log(`  Migrated: [${obs.type}] "${obs.title}" → ${result.id}`);
      migrated++;
    } catch (err) {
      console.error(`  FAILED: [${obs.type}] "${obs.title}" — ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log();
  console.log(`Done: ${migrated} migrated, ${failed} failed out of ${observations.length} total`);

  if (dryRun) {
    console.log('\nThis was a dry run. Run without --dry-run to actually migrate.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
