import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { default: TaskFiledAccess } = await import('./TaskFiledAccess');
const { filedAccessEntries, grantAllBody, takeBackBody } = await import('./filed-access');
const { stampTaskAccess, withTaskAccess } = await import('@buildd/core/token-delegation');

const NEED = { provider: 'neon', access: 'read' as const, reason: 'count failed runs' };
const AXIOM = { provider: 'axiom', access: 'read' as const, reason: null };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('filedAccessEntries', () => {
  it('granted entries first, then declared ones nobody granted', () => {
    const delegation = withTaskAccess(null, stampTaskAccess([NEED], 'u', new Date('2026-01-01T00:00:00Z')), { userId: 'u' });
    const entries = filedAccessEntries({ accessNeeds: [NEED, AXIOM] }, delegation);
    expect(entries.map(e => [e.label, e.status])).toEqual([['Neon', 'granted'], ['Axiom', 'waiting']]);
    expect(grantAllBody(entries).access.map(a => a.provider)).toEqual(['neon', 'axiom']);
    expect(takeBackBody(entries, 'neon').access).toEqual([]);
  });
  it('nothing filed: no entries', () => {
    expect(filedAccessEntries({}, null)).toEqual([]);
  });
});

describe('TaskFiledAccess', () => {
  const waiting = filedAccessEntries({ accessNeeds: [NEED] }, null);
  it('a held task names the access and the reason, and offers Grant to someone who decides access', () => {
    const html = renderToStaticMarkup(<TaskFiledAccess taskId="t1" entries={waiting} canGrant open />);
    expect(text(html)).toContain('Read Neon');
    expect(text(html)).toContain('count failed runs');
    expect(html).toContain('task-filed-access-grant');
    expect(html).toContain('id="task-filed-access"');
  });
  it('read-only for everyone else', () => {
    const html = renderToStaticMarkup(<TaskFiledAccess taskId="t1" entries={waiting} canGrant={false} open />);
    expect(html).not.toContain('task-filed-access-grant');
    expect(text(html)).toContain('starts once a team admin grants this');
  });
  it('an ended task offers nothing', () => {
    const html = renderToStaticMarkup(<TaskFiledAccess taskId="t1" entries={waiting} canGrant open={false} />);
    expect(html).not.toContain('<button');
    expect(text(html)).toContain('never granted');
  });
});
