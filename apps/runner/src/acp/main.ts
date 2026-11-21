/**
 * `buildd acp` entry: serve this machine's runner as an ACP agent on stdio.
 *
 * Point an ACP client at it, e.g. T3 Code -> Settings -> Providers -> Add
 * provider -> Local ACP command: `buildd` with argument `acp` (or, without the
 * launcher, `bun` with `run <buildd home>/apps/runner/src/acp/main.ts`).
 * The runner must already be running on this machine; this only talks to it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { AcpBridge } from './bridge';
import { notification, rpcPeer, type RpcPeer } from './rpc';
import { gitRepoRoot, projectNames, socketRunnerPort } from './runner-port';
import { ACP_SESSIONS_FILE, fileSessionLinks } from './links';
import { resolveBuilddHome } from '../buildd-home';
import { runnerSocketPath } from '../runner-socket';

function runnerVersion(): string {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

export async function runAcp(opts: { socketPath: string; version: string; builddHome: string }): Promise<void> {
  // stdout is the protocol channel: keep stray logging off it.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const write = (frame: string) => { process.stdout.write(frame); };
  // The bridge and the peer need each other: the peer dispatches to the bridge,
  // the bridge asks the client through the peer.
  let peer: RpcPeer | null = null;
  const bridge = new AcpBridge({
    runner: socketRunnerPort(opts.socketPath),
    links: fileSessionLinks(join(opts.builddHome, ACP_SESSIONS_FILE)),
    notify: (sessionId, update) => write(notification('session/update', { sessionId, update })),
    request: (method, params) => peer!.request(method, params),
    repoRootOf: gitRepoRoot,
    projectNamesOf: projectNames,
    version: opts.version,
  });
  peer = rpcPeer(bridge, write);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => { void peer!.onLine(line); });
  await new Promise<void>((resolve) => rl.once('close', () => resolve()));
}

if (import.meta.main) {
  const builddHome = resolveBuilddHome();
  await runAcp({ socketPath: runnerSocketPath(builddHome), version: runnerVersion(), builddHome });
  process.exit(0);
}
