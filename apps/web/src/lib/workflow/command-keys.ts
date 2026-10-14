/**
 * The kernel command key ring (docs/specs/workflow-kernel-library.md §3), with no
 * database code, so the control plane's entry can read it on every request
 * (health) without loading the command endpoint and its ledger at cold start.
 *
 * `KERNEL_COMMAND_SECRET` (`keyId:secret[,keyId:secret]`, two ids live during
 * rotation), and nothing else. Unset: empty. The control plane then refuses
 * every command, and the web host never submits one (it runs the package
 * itself, kernel-client.ts): the secret on both hosts is the switch.
 */
import { parseKeyRing } from '@buildd/dispatch-contract';

export function commandKeyRing(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return parseKeyRing(env.KERNEL_COMMAND_SECRET);
}

/** True when this process holds a command key: the switch that lets it submit or apply commands. */
export const commandsConfigured = (env: Record<string, string | undefined> = process.env): boolean =>
  Object.keys(commandKeyRing(env)).length > 0;
