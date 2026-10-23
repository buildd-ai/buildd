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
});
