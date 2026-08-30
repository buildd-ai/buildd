import { describe, it, expect } from 'bun:test';
import { toFrictionSignature, FRICTION_SIGNATURE_NAMESPACE } from '../failure-friction-signature';
import { normalizeErrorSignature as normalizeAnchorSignature } from '../subject-anchor-extractor';

describe('toFrictionSignature', () => {
  it('produces a slug the subject-anchor extractor accepts as a dedupe key', () => {
    const sig = toFrictionSignature('Stale worker expired (no update for <n>+ minutes)');
    expect(normalizeAnchorSignature(sig)).toBe(sig);
  });

  it('turns free-form failure prose into an anchor-valid namespaced slug', () => {
    // Raw failure text is rejected by the anchor extractor as free-form.
    expect(normalizeAnchorSignature('Stale worker expired (no update for 15+ minutes)')).toBeNull();
    const sig = toFrictionSignature('Stale worker expired (no update for 15+ minutes)');
    expect(normalizeAnchorSignature(sig)).toBe(sig);
  });

  it('namespaces every signature so these keys never collide with pattern slugs', () => {
    const sig = toFrictionSignature('git fatal: bad revision');
    expect(sig.startsWith(`${FRICTION_SIGNATURE_NAMESPACE}:`)).toBe(true);
  });

  it('is deterministic for the same normalized signature', () => {
    const a = toFrictionSignature('Deferred: another Codex worker (<id>) is already active');
    const b = toFrictionSignature('Deferred: another Codex worker (<id>) is already active');
    expect(a).toBe(b);
  });

  it('keeps the human-readable stem so a reader can tell what the key means', () => {
    const sig = toFrictionSignature('Stale worker expired (no update for <n>+ minutes)');
    expect(sig).toContain('stale_worker_expired');
  });

  it('bounds the slug length regardless of input length', () => {
    const sig = toFrictionSignature('a'.repeat(500));
    expect(sig.length).toBeLessThanOrEqual(FRICTION_SIGNATURE_NAMESPACE.length + 1 + 48);
  });

  it('distinguishes two signatures that share a long common prefix', () => {
    const prefix = 'Worker exited before producing any output because the sandbox ';
    const a = toFrictionSignature(`${prefix}could not mount the workspace`);
    const b = toFrictionSignature(`${prefix}could not reach the network`);
    expect(a).not.toBe(b);
    expect(normalizeAnchorSignature(a)).toBe(a);
    expect(normalizeAnchorSignature(b)).toBe(b);
  });

  it('handles a signature made entirely of placeholders and punctuation', () => {
    const sig = toFrictionSignature('<id> — <n>: <path>');
    expect(normalizeAnchorSignature(sig)).toBe(sig);
  });

  it('returns a stable key for the empty-error placeholder', () => {
    const sig = toFrictionSignature('(no error message)');
    expect(normalizeAnchorSignature(sig)).toBe(sig);
    expect(sig).toContain('no_error_message');
  });
});
