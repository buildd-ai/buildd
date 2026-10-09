import { describe, expect, it } from 'bun:test';
import {
  initialRoleKind,
  newRoleKinds,
  newRoleRequestBody,
  personalRoleAccess,
  personalRoleEditorPath,
  responseErrorMessage,
  splitTeamLevelRows,
} from './personal-roles-view';

const VIEWER = 'user-viewer';
const OTHER = 'user-other';

describe('splitTeamLevelRows', () => {
  const rows = [
    { id: 't1', slug: 'builder', ownerUserId: null, visibility: 'team' },
    { id: 'p1', slug: 'mine-private', ownerUserId: VIEWER, visibility: 'private' },
    { id: 'p2', slug: 'mine-shared', ownerUserId: VIEWER, visibility: 'team' },
    { id: 'p3', slug: 'their-shared', ownerUserId: OTHER, visibility: 'team' },
    { id: 'p4', slug: 'their-private', ownerUserId: OTHER, visibility: 'private' },
  ];

  it('puts team roles, own personal roles and teammates\' shared roles in their own lists', () => {
    const { teamRoles, mine, sharedByOthers } = splitTeamLevelRows(rows, VIEWER);
    expect(teamRoles.map(r => r.id)).toEqual(['t1']);
    expect(mine.map(r => r.id)).toEqual(['p1', 'p2']);
    expect(sharedByOthers.map(r => r.id)).toEqual(['p3']);
  });

  it('never surfaces another member\'s private role', () => {
    const all = Object.values(splitTeamLevelRows(rows, VIEWER)).flat().map(r => r.id);
    expect(all).not.toContain('p4');
  });

  it('a personal row never counts as a team role, whatever its visibility', () => {
    const { teamRoles } = splitTeamLevelRows(rows, 'someone-else');
    expect(teamRoles.map(r => r.id)).toEqual(['t1']);
  });
});

describe('personalRoleEditorPath', () => {
  it('carries the id, since a personal slug is not unique in the team', () => {
    expect(personalRoleEditorPath({ id: 'abc', slug: 'reviewer' })).toBe('/app/team/reviewer/settings?id=abc');
  });
});

describe('personalRoleAccess', () => {
  it('owner edits and shares a private role but cannot promote it', () => {
    expect(personalRoleAccess({ isOwner: true, visibility: 'private', canManageRoles: false }))
      .toEqual({ canEdit: true, canShare: true, canPromote: false });
  });

  it('an owner who is also an admin still cannot promote while private', () => {
    expect(personalRoleAccess({ isOwner: true, visibility: 'private', canManageRoles: true }).canPromote).toBe(false);
  });

  it('admin on a shared role edits, shares and promotes', () => {
    expect(personalRoleAccess({ isOwner: false, visibility: 'team', canManageRoles: true }))
      .toEqual({ canEdit: true, canShare: true, canPromote: true });
  });

  it('a plain member on a teammate\'s shared role gets read-only', () => {
    expect(personalRoleAccess({ isOwner: false, visibility: 'team', canManageRoles: false }))
      .toEqual({ canEdit: false, canShare: false, canPromote: false });
  });

  it('an admin gets nothing on a private role that is not theirs', () => {
    expect(personalRoleAccess({ isOwner: false, visibility: 'private', canManageRoles: true }))
      .toEqual({ canEdit: false, canShare: false, canPromote: false });
  });
});

describe('newRoleKinds / initialRoleKind', () => {
  it('a member with only create_personal_roles is offered "Just for me"', () => {
    const kinds = newRoleKinds({ createPersonal: true, manageTeam: false });
    expect(kinds).toEqual(['personal']);
    expect(initialRoleKind(kinds)).toBe('personal');
    expect(initialRoleKind(kinds, 'team')).toBe('personal');
  });

  it('an admin is offered both and starts on team unless personal is asked for', () => {
    const kinds = newRoleKinds({ createPersonal: true, manageTeam: true });
    expect(kinds).toEqual(['personal', 'team']);
    expect(initialRoleKind(kinds)).toBe('team');
    expect(initialRoleKind(kinds, 'personal')).toBe('personal');
    expect(initialRoleKind(kinds, 'bogus')).toBe('team');
  });

  it('nothing held offers nothing', () => {
    expect(newRoleKinds({ createPersonal: false, manageTeam: false })).toEqual([]);
    expect(initialRoleKind([])).toBeNull();
  });
});

describe('newRoleRequestBody', () => {
  it('a personal role posts personal: true with the team id', () => {
    expect(newRoleRequestBody('personal', 'team-1', { name: 'Mine', content: 'x' }))
      .toEqual({ name: 'Mine', content: 'x', teamId: 'team-1', isRole: true, personal: true });
  });

  it('a team role does not carry personal', () => {
    const body = newRoleRequestBody('team', 'team-1', { name: 'Ours', content: 'x' });
    expect(body.personal).toBeUndefined();
    expect(body.teamId).toBe('team-1');
  });
});

describe('responseErrorMessage', () => {
  it('shows the server\'s message (e.g. a 409 slug clash) as-is', () => {
    const clash = { error: 'The team already has a team role with slug "builder". Rename this role before sharing it.' };
    expect(responseErrorMessage(clash, 'Failed')).toBe(clash.error);
  });

  it('falls back when the body has no usable error', () => {
    expect(responseErrorMessage(null, 'Failed')).toBe('Failed');
    expect(responseErrorMessage({ error: '  ' }, 'Failed')).toBe('Failed');
    expect(responseErrorMessage({ error: 42 }, 'Failed')).toBe('Failed');
  });
});
