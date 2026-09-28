/**
 * The visual auditor's work kind (docs/design/visual-qa-human-review.md,
 * "Kind"): audit tasks were inserted without `kind`, and the role had no
 * mapping, so no glyph showed anywhere. The role mapping fixes existing rows
 * through resolveWorkKind with no backfill.
 */
import { describe, expect, it } from 'bun:test';
import { ROLE_TO_WORK_KIND, resolveWorkKind, workKindLane } from '../mission-helpers';

describe('visual-auditor work kind', () => {
  it('maps the visual-auditor role to observation', () => {
    expect(ROLE_TO_WORK_KIND['visual-auditor']).toBe('observation');
  });

  it('resolves a row with kind NULL through its role', () => {
    expect(resolveWorkKind({ kind: null, roleSlug: 'visual-auditor' })).toEqual({ kind: 'observation', source: 'role' });
  });

  it('an explicit kind still wins over the role', () => {
    expect(resolveWorkKind({ kind: 'engineering', roleSlug: 'visual-auditor' })).toEqual({ kind: 'engineering', source: 'kind' });
  });

  it('lands in the check lane', () => {
    expect(workKindLane({ kind: null, roleSlug: 'visual-auditor' })).toBe('check');
  });
});
