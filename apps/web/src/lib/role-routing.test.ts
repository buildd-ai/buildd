import { describe, it, expect } from 'bun:test';
import {
  applyRoutingPatch,
  parseRoutingPatch,
  readRoleRouting,
  renderRoutingCriterion,
  whenToUseFromFrontmatter,
  NOT_FOR_MAX,
  WHEN_TO_USE_MAX,
  WHEN_TO_USE_MIN,
} from './role-routing';

/** A role's routing text (role-routing.md §2): validated to the limits, never truncated. */

const GOOD = 'Code changes that end in a PR: features, bug fixes.';

describe('parseRoutingPatch', () => {
  it('says nothing when the body says nothing', () => {
    expect(parseRoutingPatch({ content: 'no frontmatter' })).toEqual({ ok: true, patch: null });
  });

  it('accepts text within the limits, trimmed', () => {
    expect(parseRoutingPatch({ whenToUse: `  ${GOOD} `, notFor: 'Research (Researcher)' }))
      .toEqual({ ok: true, patch: { whenToUse: GOOD, notFor: 'Research (Researcher)' } });
  });

  it('rejects whenToUse outside 20–300 characters rather than truncating', () => {
    const short = parseRoutingPatch({ whenToUse: 'builder' });
    expect(short.ok).toBe(false);
    const long = parseRoutingPatch({ whenToUse: 'x'.repeat(WHEN_TO_USE_MAX + 1) });
    expect(long.ok).toBe(false);
    expect(parseRoutingPatch({ whenToUse: 'x'.repeat(WHEN_TO_USE_MIN) }).ok).toBe(true);
  });

  it('rejects notFor over 200 characters and non-strings', () => {
    expect(parseRoutingPatch({ notFor: 'x'.repeat(NOT_FOR_MAX + 1) }).ok).toBe(false);
    expect(parseRoutingPatch({ whenToUse: 42 }).ok).toBe(false);
  });

  it('null or blank clears', () => {
    expect(parseRoutingPatch({ whenToUse: null, notFor: '' })).toEqual({ ok: true, patch: { whenToUse: null, notFor: null } });
  });

  it('reads when_to_use from SKILL.md frontmatter when the body does not state it', () => {
    const content = `---\nname: Docs\nwhen_to_use: "Documentation changes: READMEs, guides and specs."\n---\nYou write docs.`;
    expect(parseRoutingPatch({ content })).toEqual({ ok: true, patch: { whenToUse: 'Documentation changes: READMEs, guides and specs.' } });
    expect(parseRoutingPatch({ content, whenToUse: GOOD })).toEqual({ ok: true, patch: { whenToUse: GOOD } });
    expect(parseRoutingPatch({ content: '---\nwhen_to_use: docs\n---\n' }).ok).toBe(false);
  });
});

describe('whenToUseFromFrontmatter', () => {
  it('only reads the frontmatter block', () => {
    expect(whenToUseFromFrontmatter('when_to_use: not frontmatter')).toBeNull();
    expect(whenToUseFromFrontmatter('---\nname: x\n---\nwhen_to_use: body')).toBeNull();
    expect(whenToUseFromFrontmatter(undefined)).toBeNull();
  });
});

describe('applyRoutingPatch', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('keeps other metadata keys and stamps updatedAt', () => {
    expect(applyRoutingPatch({ defaultRoleVersion: 2 }, { whenToUse: GOOD }, now)).toEqual({
      defaultRoleVersion: 2, routing: { whenToUse: GOOD, updatedAt: now.toISOString() },
    });
  });

  it('keeps fields the patch does not touch, and an opt-out', () => {
    const meta = { routing: { whenToUse: GOOD, notFor: 'Old', disabled: true, updatedAt: 'x' } };
    expect(applyRoutingPatch(meta, { notFor: 'New' }, now).routing).toEqual({ whenToUse: GOOD, notFor: 'New', disabled: true, updatedAt: now.toISOString() });
  });

  it('drops the routing key when everything is cleared', () => {
    expect(applyRoutingPatch({ routing: { whenToUse: GOOD }, other: 1 }, { whenToUse: null }, now)).toEqual({ other: 1 });
  });

  it('tolerates missing or garbage metadata', () => {
    expect(applyRoutingPatch(null, { whenToUse: GOOD }, now).routing).toMatchObject({ whenToUse: GOOD });
    expect(applyRoutingPatch([1, 2], { whenToUse: GOOD }, now).routing).toMatchObject({ whenToUse: GOOD });
  });
});

describe('readRoleRouting / renderRoutingCriterion', () => {
  it('reads what is there and ignores garbage', () => {
    expect(readRoleRouting({ routing: { whenToUse: ` ${GOOD} `, notFor: 5, disabled: 'yes' } })).toEqual({ whenToUse: GOOD });
    expect(readRoleRouting({ routing: { disabled: true } })).toEqual({ disabled: true });
    expect(readRoleRouting(null)).toBeNull();
    expect(readRoleRouting({ routing: 'x' })).toBeNull();
  });

  it('renders "<whenToUse> Not for: <notFor>."', () => {
    expect(renderRoutingCriterion({ whenToUse: GOOD })).toBe(GOOD);
    expect(renderRoutingCriterion({ whenToUse: GOOD, notFor: 'Research (Researcher).' })).toBe(`${GOOD} Not for: Research (Researcher).`);
  });
});
