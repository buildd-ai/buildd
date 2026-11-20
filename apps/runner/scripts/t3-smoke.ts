import { T3Backend } from '../src/backends/t3-backend';

// bun apps/runner/scripts/t3-smoke.ts <dedicated-thread-id> <thread-worktree> <prompt-file>
// The thread must already exist in T3. This sends one real turn using its existing model and permissions.
const [threadId, cwd, promptFile] = process.argv.slice(2);
if (!threadId || !cwd || !promptFile) {
  console.error('Usage: bun apps/runner/scripts/t3-smoke.ts <dedicated-thread-id> <thread-worktree> <prompt-file>');
  process.exit(2);
}
// On Windows, a command array can name the Electron executable and bundled bin.mjs directly.
const command: unknown = process.env.BUILDD_T3_COMMAND ? JSON.parse(process.env.BUILDD_T3_COMMAND) : undefined;
if (command !== undefined && (!Array.isArray(command) || command.length === 0 || !command.every(x => typeof x === 'string' && x.length > 0))) {
  throw new Error('BUILDD_T3_COMMAND must be a non-empty JSON array of command arguments');
}
const backend = new T3Backend({ threadId, command: command as string[] | undefined });
for await (const event of backend.runStreamed({
  prompt: await Bun.file(promptFile).text(), cwd, sessionId: threadId, allowReducedConfinement: true,
})) {
  console.log(JSON.stringify(event));
  if (event.type === 'error') process.exitCode = 1;
}
