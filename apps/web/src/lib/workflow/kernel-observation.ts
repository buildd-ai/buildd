/**
 * A kernel-owned PR whose close or merge the kernel could not take in (S4a): its own live read
 * of GitHub failed, or the control plane that would have read it did not answer, so no transition
 * ran. A fast heal is scheduled (kernel-heal.ts); the caller must not take a legacy path for the
 * PR (the kernel still owns it) and must not report success.
 *
 * Its own module so both the seam (which throws it on the host) and the client (which throws it
 * from a door's answer) import it without importing each other.
 */
export class KernelObservationFailed extends Error {
  constructor(readonly deliveryId: string, readonly reason: string) {
    super(`kernel could not observe the PR of delivery ${deliveryId}: ${reason}`);
    this.name = 'KernelObservationFailed';
  }
}
