import { describe, expect, it } from 'bun:test';
import { designArtifactLines, designSourceFromContext } from '../src/claude-ai-artifacts';

const ID = '00000000-0000-4000-8000-0000000000a1';
const INFO = [{ id: 'phone-nav', name: 'Navigation (phone)', viewport: '390x844' }, { id: 'desktop-nav', name: 'Navigation (desktop)', viewport: '1440x900' }];

describe('design screens in the context a builder gets', () => {
  it('keeps valid screen names and sizes, drops malformed ones', () => {
    const ds = designSourceFromContext({ designSource: { artifactId: ID, screenInfo: [...INFO, { id: 'x y', name: 'bad id', viewport: '1x1' }, { id: 'ok', name: 5, viewport: 'wide' }, 'junk'] } });
    expect(ds?.screenInfo).toEqual(INFO);
  });
  it('lists each screen with its name and size in the prompt', () => {
    const text = designArtifactLines({ artifactId: ID, screenInfo: INFO }).join(' ');
    expect(text).toContain('`phone-nav` Navigation (phone), 390x844');
    expect(text).toContain('`desktop-nav` Navigation (desktop), 1440x900');
  });
  it('names a screen once, beside the criteria that name it', () => {
    const text = designArtifactLines({ artifactId: ID, screens: ['phone-nav'], screenInfo: INFO, criteria: [{ id: 'AC-1', screens: ['phone-nav'] }] }).join(' ');
    expect(text).toContain('`phone-nav` (AC-1)');
    expect(text).toContain('Navigation (phone), 390x844');
    expect(text).not.toContain('Navigation (desktop)');
  });

  // Living Spec f43b6a61 R-15 / AC-12.
  const ROW = { id: 'c-row', name: 'Delivery row', viewport: '360x120', kind: 'component' as const, code: 'apps/web/src/components/X.tsx' };
  const MANY = [...Array.from({ length: 20 }, (_, i) => ({ id: `page-${i}`, name: `Page ${i}`, viewport: '1440x900' })), ROW];

  it('keeps kind and code of a screen, and drops a bad kind or code', () => {
    const ds = designSourceFromContext({ designSource: { artifactId: ID, screenInfo: [ROW, { ...ROW, id: 'w', kind: 'widget' }, { ...ROW, id: 'p', code: '../x' }] } });
    expect(ds?.screenInfo).toEqual([ROW, { id: 'w', name: ROW.name, viewport: ROW.viewport, code: ROW.code }, { id: 'p', name: ROW.name, viewport: ROW.viewport, kind: 'component' }]);
  });

  it('lists only the screens its criteria name, each with how to read it on its own', () => {
    const text = designArtifactLines({ artifactId: ID, revision: 2, screens: ['c-row'], screenInfo: MANY, criteria: [{ id: 'AC-12', screens: ['c-row'] }] }).join('\n');
    expect(text).toContain('`c-row`');
    expect(text).toContain(`manage_designs action=screen designId=${ID} revision=2 screenId=c-row`);
    expect(text).toContain('component');
    expect(text).toContain('apps/web/src/components/X.tsx');
    expect(text).not.toMatch(/page-\d/);
  });
});
