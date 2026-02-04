#!/usr/bin/env node
/**
 * Buildd CLI for OpenClaw
 *
 * Usage:
 *   buildd list              - List available tasks
 *   buildd claim             - Claim the next task
 *   buildd progress 50 msg   - Report 50% progress
 *   buildd complete summary  - Mark task complete
 *   buildd fail reason       - Mark task failed
 */

import {
  listTasks,
  claimTask,
  reportProgress,
  completeTask,
  failTask,
  getCurrentWorkerId,
} from './index.js';

async function main() {
  const [, , command, ...args] = process.argv;

  if (!process.env.BUILDD_API_KEY) {
    console.error('Error: BUILDD_API_KEY environment variable is required');
    console.error('Get your API key from https://app.buildd.dev/settings');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'list': {
        const tasks = await listTasks({ status: 'pending', limit: 10 });
        if (tasks.length === 0) {
          console.log('No pending tasks available.');
        } else {
          console.log(`Found ${tasks.length} pending task(s):\n`);
          for (const task of tasks) {
            console.log(`[${task.id}] ${task.title}`);
            console.log(`  Workspace: ${task.workspace?.name || 'Unknown'}`);
            console.log(`  Priority: ${task.priority}`);
            if (task.description) {
              console.log(`  ${task.description.slice(0, 100)}...`);
            }
            console.log();
          }
        }
        break;
      }

      case 'claim': {
        const worker = await claimTask();
        if (!worker) {
          console.log('No tasks available to claim.');
        } else {
          console.log('Task claimed successfully!\n');
          console.log(`Worker ID: ${worker.id}`);
          console.log(`Task: ${worker.task.title}`);
          console.log(`Branch: ${worker.branch}`);
          console.log(`\nDescription:\n${worker.task.description || 'No description'}`);
          console.log(`\n# Set this to resume later:`);
          console.log(`export BUILDD_WORKER_ID=${worker.id}`);
        }
        break;
      }

      case 'progress': {
        const percent = parseInt(args[0], 10);
        const message = args.slice(1).join(' ') || undefined;

        if (isNaN(percent) || percent < 0 || percent > 100) {
          console.error('Usage: buildd progress <0-100> [message]');
          process.exit(1);
        }

        await reportProgress(percent, message);
        console.log(`Progress updated: ${percent}%${message ? ` - ${message}` : ''}`);
        break;
      }

      case 'complete': {
        const summary = args.join(' ') || undefined;
        await completeTask(summary);
        console.log('Task marked as completed!');
        if (summary) {
          console.log(`Summary: ${summary}`);
        }
        break;
      }

      case 'fail': {
        const reason = args.join(' ');
        if (!reason) {
          console.error('Usage: buildd fail <reason>');
          process.exit(1);
        }

        await failTask(reason);
        console.log(`Task marked as failed: ${reason}`);
        break;
      }

      case 'status': {
        const workerId = getCurrentWorkerId();
        if (workerId) {
          console.log(`Current worker ID: ${workerId}`);
        } else {
          console.log('No active task. Use "buildd claim" to claim one.');
        }
        break;
      }

      default:
        console.log(`Buildd CLI for OpenClaw

Usage:
  buildd list              List available tasks
  buildd claim             Claim the next available task
  buildd progress <n> [m]  Report progress (0-100) with optional message
  buildd complete [msg]    Mark current task as completed
  buildd fail <reason>     Mark current task as failed
  buildd status            Show current worker ID

Environment:
  BUILDD_API_KEY           Your Buildd API key (required)
  BUILDD_SERVER            Server URL (default: https://app.buildd.dev)
  BUILDD_WORKER_ID         Resume work on a specific worker
`);
        break;
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
