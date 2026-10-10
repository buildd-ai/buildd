/**
 * `buildd-once --reset-container`: the reset between two tasks in one warm
 * cloud container (container-reset.ts). Exit 0 and RESET_OK_LINE only when
 * the result was verified clean; anything else exits 1 and the agent replaces
 * the container. Refuses outside a cloud container: on any other host it
 * would kill the user's own processes and delete their HOME.
 */
import { existsSync, readFileSync } from 'fs';
import { bunCacheDir } from './warm-repo';
import {
  RESET_FAILED_LINE_PREFIX,
  RESET_OK_LINE,
  containerResetPaths,
  listProcsFromProc,
  resetContainer,
} from './container-reset';

function inCloudContainer(env: Record<string, string | undefined>): boolean {
  if (env.BUILDD_EXECUTOR !== 'cloud') return false;
  // The image's init is tini (Dockerfile.once ENTRYPOINT).
  try {
    return existsSync('/proc/1/cmdline') && readFileSync('/proc/1/cmdline', 'utf-8').split('\0')[0]!.endsWith('tini');
  } catch {
    return false;
  }
}

const env = process.env as Record<string, string | undefined>;
if (!inCloudContainer(env)) {
  console.log(`${RESET_FAILED_LINE_PREFIX}not_a_cloud_container`);
  process.exit(1);
}
const uid = process.getuid?.();
if (uid === undefined || uid === 0) {
  console.log(`${RESET_FAILED_LINE_PREFIX}bad_uid`);
  process.exit(1);
}
const result = resetContainer(containerResetPaths(env, bunCacheDir(env)), {
  listProcs: listProcsFromProc,
  kill: (pid) => process.kill(pid, 'SIGKILL'),
  selfPid: process.pid,
  uid,
  sleep: (ms) => Bun.sleepSync(ms),
  log: (m) => console.log(m),
});
if (result.handover) console.log(`BUILDD_HANDOVER=${JSON.stringify({ mode: 'deps', ...result.handover })}`);
console.log(`[reset] killed ${result.killed} process(es); kept ${result.keptPacks} pack(s)${result.keptCache ? ' and the dependency cache' : ''}`);
if (!result.ok) {
  console.log(`${RESET_FAILED_LINE_PREFIX}${(result.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}
console.log(RESET_OK_LINE);
process.exit(0);
