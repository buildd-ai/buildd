/**
 * `gateFrictionSignature` — composes the dedupe key a gate 400 hands back so a
 * caller with no traced error (a creation-time or completion-time refusal,
 * never a worker failure) can still give `create_task` a stable
 * `frictionSignature`. See packages/core/gate-events.ts for the ledger this
 * reuses, and subject-anchor-extractor.ts's `normalizeErrorSignature` for the
 * regex the composed key must satisfy.
 */
import { describe, it, expect } from 'bun:test';
import { gateFrictionSignature } from '../gate-friction-signature';
import { normalizeErrorSignature as validateAnchorSignature } from '../subject-anchor-extractor';

describe('gateFrictionSignature', () => {
  it('is accepted by the subject-anchor namespace:slug regex', () => {
    const sig = gateFrictionSignature('manifest_required', 'pathManifest is required');
    expect(validateAnchorSignature(sig)).toBe(sig);
  });

  it('composes as gate:<stem>_<hash> — exactly one colon, namespaced "gate"', () => {
    const sig = gateFrictionSignature('manifest_required', 'pathManifest is required');
    expect(sig.split(':')).toHaveLength(2);
    expect(sig.startsWith('gate:')).toBe(true);
  });

  it('regression: a second colon between the namespace and its slug would be silently rejected by the anchor regex', () => {
    // This is the trap the task description calls out by name: "gate:slug:hash"
    // parses as three colon-separated segments and fails validateAnchorSignature
    // (returns null) instead of erroring loudly — so the composer must never
    // reintroduce a colon after the namespace prefix.
    const trap = 'gate:manifest_required:deadbeef';
    expect(validateAnchorSignature(trap)).toBeNull();

    const sig = gateFrictionSignature('manifest_required', 'pathManifest is required');
    expect((sig.match(/:/g) ?? []).length).toBe(1);
    expect(validateAnchorSignature(sig)).not.toBeNull();
  });

  it('keeps a human-readable stem so a reader can tell which gate a signature belongs to', () => {
    const sig = gateFrictionSignature('manifest_required', 'pathManifest is required');
    expect(sig).toContain('manifest_required');
  });

  it('is stable for the same (gate, reason) pair', () => {
    const a = gateFrictionSignature('manifest_required', 'pathManifest is required');
    const b = gateFrictionSignature('manifest_required', 'pathManifest is required');
    expect(a).toBe(b);
  });

  it('collapses reasons that differ only in volatile detail, same as the gate_events ledger row would', () => {
    // Mirrors the create_pr branch-mismatch case that produced four distinct
    // ledger rows before normalizeErrorSignature's quoted-slug rule existed.
    const a = gateFrictionSignature(
      'pr_head_mismatch',
      "Task PR head 'buildd_ed211c59-consolidate-the-create-pr-bran' does not match this worker's own branch ('buildd_ed211c59-consolidate-the-create-pr-bran-wf4817cb0').",
    );
    const b = gateFrictionSignature(
      'pr_head_mismatch',
      "Task PR head 'mission/spec-conformance-the-ledger-f02e0dc0-wcda33d93' does not match this worker's own branch ('mission/spec-conformance-the-ledger-f02e0dc0').",
    );
    expect(a).toBe(b);
  });

  it('differs for a different reason under the same gate', () => {
    const a = gateFrictionSignature('task_param_vocabulary', 'kind must be one of: research, engineering');
    const b = gateFrictionSignature('task_param_vocabulary', 'complexity must be one of: simple, normal, complex');
    expect(a).not.toBe(b);
  });

  it('differs for the same reason under a different gate', () => {
    const a = gateFrictionSignature('manifest_required', 'pathManifest is required');
    const b = gateFrictionSignature('emits_plan_manifest_required', 'pathManifest is required');
    expect(a).not.toBe(b);
  });
});
