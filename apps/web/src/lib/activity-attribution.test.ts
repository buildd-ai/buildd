/**
 * Who work is for and who filed it (spec 9430a28f R-4, AC-4). Only the
 * lineage the database recorded counts (`tasks.requesterSource`, written by
 * the requester trigger); anything else reads unattributed, and the identity
 * filters never hide unattributed work from All.
 */
import { describe, expect, it } from 'bun:test';
import { attributionOf, matchesWho, whoFiltersReliable, type Attribution } from './activity-attribution';

const ME = 'user-me';
const ADA = 'user-ada';
const names = new Map([[ME, 'Me Myself'], [ADA, 'Ada']]);

describe('R-4: attribution only from recorded lineage', () => {
  it('a person who filed it themselves: filed by them', () => {
    expect(attributionOf({ createdByUserId: ME, requesterSource: 'explicit' }, ME, names)).toMatchObject({
      known: true, requester: { id: ME, you: true }, filedBy: 'requester', text: 'Filed by you',
    });
    expect(attributionOf({ createdByUserId: ADA, requesterSource: 'explicit' }, ME, names).text).toBe('Filed by Ada');
  });

  it('an agent filed it for a person: the person is accountable, the agent is the filer', () => {
    const a = attributionOf({ createdByUserId: ADA, requesterSource: 'parent', createdByWorkerId: 'w-1' }, ME, names);
    expect(a).toMatchObject({ known: true, requester: { id: ADA, you: false }, filedBy: 'agent' });
    expect(a.text).toBe('For Ada · filed by an agent');
  });

  it('a schedule filed it for a person', () => {
    expect(attributionOf({ createdByUserId: ME, requesterSource: 'schedule' }, ME, names).text).toBe('For you · from a schedule');
  });

  it('derived from a mission with no recorded filer: names only who it is for', () => {
    expect(attributionOf({ createdByUserId: ADA, requesterSource: 'mission' }, ME, names).text).toBe('For Ada');
  });

  it('a backfill that found the person counts; one that could not stays unknown', () => {
    expect(attributionOf({ createdByUserId: ADA, requesterSource: 'backfill_parent' }, ME, names).known).toBe(true);
    for (const src of ['backfill_none', 'backfill_not_member', 'none']) {
      expect(attributionOf({ createdByUserId: null, requesterSource: src }, ME, names)).toMatchObject({ known: false, text: 'Unattributed' });
    }
  });

  it('a person named with no record of how is never guessed at', () => {
    expect(attributionOf({ createdByUserId: ADA, requesterSource: null }, ME, names)).toMatchObject({ known: false, requester: null, text: 'Unattributed' });
  });

  it('no lineage fields at all reads unattributed', () => {
    expect(attributionOf({}, ME, names)).toMatchObject({ known: false, text: 'Unattributed' });
  });

  it('a known person whose name is not readable is still not invented', () => {
    expect(attributionOf({ createdByUserId: 'user-gone', requesterSource: 'explicit' }, ME, names).text).toBe('Filed by a teammate');
  });
});

describe('AC-4: identity filters', () => {
  const mine = attributionOf({ createdByUserId: ME, requesterSource: 'explicit' }, ME, names);
  const forMe = attributionOf({ createdByUserId: ME, requesterSource: 'parent', createdByWorkerId: 'w' }, ME, names);
  const ada = attributionOf({ createdByUserId: ADA, requesterSource: 'explicit' }, ME, names);
  const unknown = attributionOf({}, ME, names);

  it('All keeps everything, unattributed included', () => {
    for (const a of [mine, forMe, ada, unknown, undefined]) expect(matchesWho(a, 'all')).toBe(true);
  });

  it('For me: work I am accountable for, filed by me or for me', () => {
    expect([mine, forMe, ada, unknown].map(a => matchesWho(a, 'for-me'))).toEqual([true, true, false, false]);
  });

  it('Filed by me: only what I filed myself', () => {
    expect([mine, forMe, ada, unknown].map(a => matchesWho(a, 'filed-by-me'))).toEqual([true, false, false, false]);
  });

  it('filters are offered only with a known viewer and some recorded lineage in view', () => {
    const some: Attribution[] = [unknown, ada];
    expect(whoFiltersReliable(some, ME)).toBe(true);
    expect(whoFiltersReliable(some, null)).toBe(false);
    expect(whoFiltersReliable([unknown, unknown], ME)).toBe(false);
    expect(whoFiltersReliable([], ME)).toBe(false);
  });
});
