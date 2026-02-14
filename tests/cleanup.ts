#!/usr/bin/env bun
/**
 * Cleanup script: delete all test-prefixed tasks from a server.
 *
 * Usage:
 *   BUILDD_TEST_SERVER=https://preview.vercel.app BUILDD_API_KEY=bld_xxx bun run tests/cleanup.ts
 *   # or:
 *   bun run test:cleanup
 */

import { requireTestEnv, createTestApi } from './test-utils';

const { server, apiKey } = requireTestEnv();
const { api } = createTestApi(server, apiKey);

const TEST_PREFIXES = ['[DOGFOOD]', '[INTEG-TEST]', '[E2E-TEST]', '\u{1F3D7}'];

async function main() {
  console.log(`Cleaning test tasks from ${server}...\n`);

  const { tasks } = await api('/api/tasks');
  const testTasks = tasks.filter((t: any) =>
    TEST_PREFIXES.some(prefix => t.title?.startsWith(prefix)) ||
    t.title?.includes('Integration Test') ||
    t.title?.includes('Concurrency test') ||
    t.title?.includes('Capacity test') ||
    t.title?.includes('Race condition test') ||
    t.title?.includes('Error test task')
  );

  if (testTasks.length === 0) {
    console.log('No test tasks found.');
    return;
  }

  console.log(`Found ${testTasks.length} test task(s). Deleting...`);

  let deleted = 0;
  let failed = 0;

  for (const task of testTasks) {
    try {
      await api(`/api/tasks/${task.id}?force=true`, { method: 'DELETE' });
      deleted++;
      console.log(`  Deleted: ${task.title} (${task.id})`);
    } catch (err: any) {
      failed++;
      console.log(`  Failed: ${task.title} (${task.id}): ${err.message}`);
    }
  }

  console.log(`\nDone: ${deleted} deleted, ${failed} failed.`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
