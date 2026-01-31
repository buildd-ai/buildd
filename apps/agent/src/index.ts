#!/usr/bin/env bun

import { parseArgs } from 'util';
import { BuilddAgent } from './agent';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    server: {
      type: 'string',
      default: process.env.BUILDD_SERVER || 'http://localhost:3000',
    },
    'api-key': {
      type: 'string',
      default: process.env.BUILDD_API_KEY,
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
  console.error('Error: BUILDD_API_KEY is required');
  console.error('Set via environment variable or --api-key flag');
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
