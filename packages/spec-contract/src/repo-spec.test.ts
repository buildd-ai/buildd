import { describe, expect, it } from 'bun:test';
import {
  buildSpecIndex,
  crossCheckSpecs,
  lintSpecFile,
  nativeSuccessorRef,
  type IndexedSpec,
  type SpecFrontmatter,
} from './repo-spec';

const spec = (slug: string, fm: SpecFrontmatter): IndexedSpec => ({ file: `${slug}.md`, slug, fm });
const old = (superseded_by: string) =>
  spec('old', { title: 'Old', status: 'superseded', superseded_by });

describe('superseded_by native Living Spec reference', () => {
  it('parses the living-spec: shape and leaves repo slugs alone', () => {
    expect(nativeSuccessorRef('living-spec:Claim overlap')).toBe('Claim overlap');
    expect(nativeSuccessorRef('some-slug')).toBeNull();
    expect(nativeSuccessorRef(undefined)).toBeNull();
  });

  it('cross check accepts a native reference without a repo successor', () => {
    expect(crossCheckSpecs([old('living-spec:Claim overlap')])).toEqual([]);
  });

  it('cross check still rejects an unknown repo slug', () => {
    expect(crossCheckSpecs([old('nope')]).join()).toContain('superseded_by unknown spec "nope"');
  });

  it('lint rejects an empty native reference', () => {
    const fm: SpecFrontmatter = { title: 'Old', status: 'superseded', owner: 'x', superseded_by: 'living-spec:  ' };
    const { errors } = lintSpecFile('old', fm, '', { domains: new Set(), exists: () => true });
    expect(errors.join()).toContain('names no Living Spec id or title');
  });

  it('index names the native successor', () => {
    expect(buildSpecIndex([old('living-spec:Claim overlap')])).toContain(
      'replaced by Living Spec `Claim overlap`',
    );
  });
});
