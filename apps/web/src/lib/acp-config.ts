/**
 * What Settings → Runners says about a runner's ACP bridge (docs/specs/acp-bridge.md).
 * The runner reports `environment.acp`; buildd never guesses it from a version.
 * No state here says "no": an older runner is "unknown, update the runner".
 */
import type { RunnerAcpCapability } from '@buildd/shared';

export type AcpState = 'ready' | 'elsewhere' | 'unknown';
export interface AcpStatus { state: AcpState; label: string; detail?: string }

export function acpStatus(acp: RunnerAcpCapability | null | undefined): AcpStatus {
  if (!acp) return { state: 'unknown', label: 'Unknown, update the runner', detail: 'This runner has not reported ACP support. Update it to find out.' };
  if (acp.shimPath === null && acp.platform !== 'win32') {
    return { state: 'unknown', label: 'Unknown, update the runner', detail: 'The runner has not written the buildd-acp shim yet. Restart it on its latest version.' };
  }
  if (!acp.pointsHere) {
    return { state: 'elsewhere', label: 'Shim points elsewhere', detail: `${acp.shimPath ?? 'buildd-acp'} launches ${acp.target ?? 'a file this runner did not write'}, not this runner's install. Restart the installed runner to repair it.` };
  }
  return { state: 'ready', label: 'Ready', detail: `Runner ${acp.version}` };
}

export interface AcpSnippet { id: 'local' | 'ssh' | 'on-host'; title: string; where: string; text: string; note: string }

const NO_SECRET = 'No token or key: the bridge talks to the runner\'s owner-only socket.';

export function acpSnippets(acp: RunnerAcpCapability | null | undefined, hostName: string): AcpSnippet[] {
  const local = acp?.platform === 'win32' ? `"${acp.bunPath}" run "${acp.mainPath}"` : acp?.shimPath ?? 'buildd-acp';
  const host = hostName.trim().replace(/\s+/g, '-') || 'host';
  return [
    {
      id: 'local', title: 'T3 on this machine', where: 'Settings → Providers → Local ACP command',
      text: local,
      note: `Paste it as the Local ACP command. ${NO_SECRET}`,
    },
    {
      id: 'ssh', title: 'T3 on another machine (fallback)', where: 'Settings → Providers → Local ACP command, on the machine running T3',
      text: `ssh -T -o BatchMode=yes user@${host} buildd acp`,
      note: `Prefer linked environments: have the orchestrator start the thread in the runner machine's own T3 environment, so T3's project and diffs match the run. If not linked, this command runs buildd acp on the runner host over SSH with no TTY; T3 then shows the thread under your local project, and its diff panel shows your local checkout, not the task's changes (the first message says where they are). Replace user@${host} with how you reach it. The remote shell's PATH must find buildd (a non-interactive shell skips .bashrc: put it in .profile or use the absolute shim path). ${NO_SECRET}`,
    },
    {
      id: 'on-host', title: 'T3 server on the runner host', where: 'Settings → Providers → Local ACP command, in the T3 running on the host',
      text: local,
      note: `For a T3 server on the runner host itself (a Coder workspace, or WSL beside Windows). With WSL, Windows folders such as C:\\code\\app are read as /mnt/c/code/app. ${NO_SECRET}`,
    },
  ];
}
