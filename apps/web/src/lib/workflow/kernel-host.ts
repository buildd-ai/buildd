/**
 * Which host this process is, for the kernel (docs/specs/workflow-kernel-library.md
 * §3): `control-plane` in the execution control plane Worker, `web` everywhere
 * else (Vercel, local dev, tests, scripts). Set in code by the Worker's entry
 * (apps/control-plane/src/index.ts), never read from an env var, so it cannot be
 * misconfigured. Every transition row records it (`workflow_transitions.host`,
 * AC-9), and the command client reads it to know whether it is the host.
 */
export type KernelHost = 'control-plane' | 'web';

let current: KernelHost = 'web';

export function kernelHost(): KernelHost {
  return current;
}

/** The Worker's entry calls this once at load. Tests use it to play the control plane. */
export function setKernelHost(host: KernelHost): void {
  current = host;
}
