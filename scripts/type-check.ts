/** Same root type-check scope as the former bash chain, without a shell dependency. */
import { resolve } from 'node:path';

const checks = [
  { cwd: 'apps/web', args: [] },
  { cwd: 'packages/core', args: ['--project', 'tsconfig.test-d.json'] },
  { cwd: 'apps/responder', args: [] },
  { cwd: 'packages/ai-kit', args: [] },
  { cwd: 'apps/dispatch', args: [] },
  { cwd: 'apps/model-policy', args: [] },
] as const;

type SpawnCheck = (cmd: string[], options: {
  cwd: string; stdio: ['inherit', 'inherit', 'inherit'];
}) => { exited: Promise<number> };

export async function runTypeChecks(spawn: SpawnCheck = Bun.spawn): Promise<number> {
  const root = resolve(import.meta.dir, '..');
  for (const check of checks) {
    const child = spawn([process.execPath, 'x', 'tsc', '--noEmit', ...check.args], {
      cwd: resolve(root, check.cwd), stdio: ['inherit', 'inherit', 'inherit'],
    });
    const code = await child.exited;
    if (code !== 0) return code;
  }
  return 0;
}

if (import.meta.main) {
  runTypeChecks().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Could not launch type check.');
    process.exitCode = 1;
  });
}
