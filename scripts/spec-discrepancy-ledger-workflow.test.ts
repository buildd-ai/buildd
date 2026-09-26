import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

/**
 * The ledger writer workflow is the ONLY thing that writes spec_discrepancies
 * rows (docs/design/spec-conformance.md §7/§9). Doc-fix cards sat for days
 * "awaiting the conformance re-run" partly because of how this file was wired,
 * so its shape is pinned here:
 *   - buildd dispatches it with `force: true` after a doc-fix merge, and that
 *     input must actually bypass the delta gate;
 *   - the gate pointer is this workflow's own, not the blocking checker's;
 *   - a skipped, cancelled or failed writer never advances that pointer.
 */

const y = (f: string): any => Bun.YAML.parse(readFileSync(f, 'utf8'));
const triggers = (w: any) => w.on ?? w[true as unknown as string];

const LEDGER = '.github/workflows/spec-discrepancy-ledger.yml';
const wf = y(LEDGER);
const steps: any[] = wf.jobs.ledger.steps;
const step = (prefix: string) => steps.find((s) => typeof s.name === 'string' && s.name.startsWith(prefix));

describe('spec-discrepancy-ledger.yml', () => {
  test('runs on push to dev and on workflow_dispatch with a boolean force input', () => {
    const on = triggers(wf);
    expect(on.push.branches).toEqual(['dev']);
    expect(on.workflow_dispatch.inputs.force.type).toBe('boolean');
    expect(on.workflow_dispatch.inputs.force.default).toBe(false);
  });

  test('force bypasses the delta gate, and the writer runs whenever the gate did not say skip', () => {
    const gate = step('Delta gate — decide');
    expect(gate.id).toBe('gate');
    expect(gate.if).toContain('!inputs.force');
    // A skipped gate step leaves outputs.skip empty, so the writer runs.
    expect(step('Write spec discrepancy ledger').if).toBe("steps.gate.outputs.skip != 'true'");
  });

  test('the gate reads and records its own pointer, never the blocking checker\'s', () => {
    expect(step('Delta gate — decide').run).toContain('--key spec-discrepancy-ledger-last-sha');
    expect(step('Delta gate — record').run).toContain('--key spec-discrepancy-ledger-last-sha');
  });

  test('the pointer advances only on success — never after a cancelled or failed writer', () => {
    const record = step('Delta gate — record');
    expect(record.if).toBe('success()');
    expect(String(record.if)).not.toContain('always');
  });

  test('queues rather than cancels, so a forced re-run is not killed mid-write by the next push', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  test('exactly one step writes the ledger', () => {
    const writers = steps.filter((s) => typeof s.run === 'string' && s.run.includes('specs:discrepancies'));
    expect(writers).toHaveLength(1);
  });
});
