/**
 * The `infrastructure_failure` rule's one recovery family
 * (docs/specs/failure-incident-recovery.md §16.3, §18.4). The rule is shared
 * by the capture pipeline (`visual_qa.*`) and the worker components
 * (`worker.*`); `assessIncident` picks a family by rule, so this routes each
 * incident to its component's policy by the signature's `component=`.
 */
import type { RecoveryFamily, RecoveryPolicyOutcome } from './failure-incident-recovery';
import type { StoredIncident } from './failure-incident-store';
import { createCaptureRecoveryFamily, parseCaptureSignature, type CaptureRecoveryFacts } from './failure-incident-recovery-capture';
import { workerInfraRecoveryFamily, type WorkerInfraRecoveryFacts } from './failure-incident-recovery-worker-infra';

export type InfrastructureRecoveryFacts =
  | { family: 'capture'; facts: CaptureRecoveryFacts }
  | { family: 'worker'; facts: WorkerInfraRecoveryFacts };

const isCapture = (incident: Pick<StoredIncident, 'signature'>) => parseCaptureSignature(incident.signature).component !== null;

export function createInfrastructureRecoveryFamily(
  capture: RecoveryFamily<CaptureRecoveryFacts> = createCaptureRecoveryFamily(),
  worker: RecoveryFamily<WorkerInfraRecoveryFacts> = workerInfraRecoveryFamily,
): RecoveryFamily<InfrastructureRecoveryFacts> {
  return {
    rule: 'infrastructure_failure',
    async observe(incident) {
      if (isCapture(incident)) {
        const r = await capture.observe(incident);
        return { complete: r.complete, facts: { family: 'capture', facts: r.facts } };
      }
      const r = await worker.observe(incident);
      return { complete: r.complete, facts: { family: 'worker', facts: r.facts } };
    },
    evaluate(incident, f, now): RecoveryPolicyOutcome {
      return f.family === 'capture' ? capture.evaluate(incident, f.facts, now) : worker.evaluate(incident, f.facts, now);
    },
    async afterAssess(incident, prior) {
      const family = isCapture(incident) ? capture : worker;
      await family.afterAssess?.(incident, prior);
    },
  };
}
