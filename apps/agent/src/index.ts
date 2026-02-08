#!/usr/bin/env bun

import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BuilddAgent } from './agent';

/**
 * Load ~/.buildd/config.json as fallback for env vars
 */
function loadBuilddConfig(): { apiKey?: string; builddServer?: string } {
  try {
    const configPath = join(homedir(), '.buildd', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const config = loadBuilddConfig();

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    server: {
      type: 'string',
      default: process.env.BUILDD_SERVER || config.builddServer || 'https://buildd.dev',
    },
    'api-key': {
      type: 'string',
      default: process.env.BUILDD_API_KEY || config.apiKey,
    },
    workspace: {
      type: 'string',
    },
    'max-tasks': {
      type: 'string',
      default: '3',
    },
  },
});

if (!values['api-key']) {
  console.error('Error: No API key found.');
  console.error('Run `buildd login` to authenticate, or set BUILDD_API_KEY / --api-key.');
  process.exit(1);
}

const agent = new BuilddAgent({
  serverUrl: values.server!,
  apiKey: values['api-key']!,
  workspaceId: values.workspace,
  maxTasks: parseInt(values['max-tasks']!, 10),
});

console.log('buildd agent starting...');
console.log(`Server: ${values.server}`);
console.log(`Max tasks: ${values['max-tasks']}`);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await agent.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await agent.stop();
  process.exit(0);
});

// Start agent
await agent.run();
