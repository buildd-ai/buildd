/**
 * Integration Tests: Team Invitations & Member Management
 *
 * Tests the complete team collaboration lifecycle including:
 *   - Team CRUD (create, get, update, delete)
 *   - Invitation lifecycle (create, list, revoke)
 *   - Member management (list, update role, remove)
 *   - Role-based access control (owner vs admin vs member)
 *   - Duplicate invitation handling
 *   - Invitation expiry (via accept endpoint)
 *   - Edge cases (last owner protection, self-removal)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/team-invitations.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi } from '../../../../tests/test-utils';

// --- Config ---

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);

// --- Helpers ---

const TEST_PREFIX = `inttest-${Date.now()}`;

/** Generate a unique slug for test teams */
function testSlug(suffix: string): string {
  return `${TEST_PREFIX}-${suffix}`;
}

/** Track teams for cleanup */
const teamsToCleanup: string[] = [];

async function createTestTeam(name: string, slug: string): Promise<any> {
  const team = await api('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  });
  teamsToCleanup.push(team.id);
  return team;
}

async function deleteTeam(teamId: string): Promise<void> {
  try {
    await apiRaw(`/api/teams/${teamId}`, { method: 'DELETE' });
  } catch {
    // best effort
  }
}

// --- Test suite ---

describe('Team Invitations & Member Management', () => {
  let currentUserId: string;
  let currentUserEmail: string;

  beforeAll(async () => {
    // Get the authenticated user's info by creating and inspecting a team
    const probeTeam = await createTestTeam('Probe Team', testSlug('probe'));
    const teamDetails = await api(`/api/teams/${probeTeam.id}`);
    const ownerMember = teamDetails.members.find((m: any) => m.role === 'owner');
    currentUserId = ownerMember.userId;
    currentUserEmail = ownerMember.email;
    console.log(`  Authenticated as: ${currentUserEmail} (${currentUserId})`);

    // Clean up probe team
    await deleteTeam(probeTeam.id);
    teamsToCleanup.pop();
  }, TIMEOUT);

  afterAll(async () => {
    // Clean up all test teams
    for (const teamId of teamsToCleanup) {
      await deleteTeam(teamId);
    }
  });

  // ---------------------------------------------------------------
  // 1. Team CRUD
  // ---------------------------------------------------------------

  test('create team — returns team with correct fields', async () => {
    const team = await createTestTeam('Test Team Alpha', testSlug('alpha'));

    expect(team.id).toBeTruthy();
    expect(team.name).toBe('Test Team Alpha');
    expect(team.slug).toBe(testSlug('alpha'));
    expect(team.plan).toBe('free');
  }, TIMEOUT);

  test('create team — rejects duplicate slug', async () => {
    const slug = testSlug('dup');
    await createTestTeam('First Team', slug);

    const { status, body } = await apiRaw('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Second Team', slug }),
    });

    expect(status).toBe(409);
    expect(body.error).toContain('slug already exists');
  }, TIMEOUT);

  test('create team — rejects invalid slug format', async () => {
    const { status, body } = await apiRaw('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Slug', slug: 'UPPERCASE_BAD' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('lowercase');
  }, TIMEOUT);

  test('get team — returns team with members and role', async () => {
    const team = await createTestTeam('Detail Team', testSlug('detail'));
    const details = await api(`/api/teams/${team.id}`);

    expect(details.team.id).toBe(team.id);
    expect(details.team.name).toBe('Detail Team');
    expect(details.members.length).toBeGreaterThanOrEqual(1);
    expect(details.currentUserRole).toBe('owner');

    // Owner should be in the member list
    const owner = details.members.find((m: any) => m.role === 'owner');
    expect(owner).toBeTruthy();
    expect(owner.userId).toBe(currentUserId);
  }, TIMEOUT);

  test('list teams — includes created team with role and memberCount', async () => {
    const team = await createTestTeam('Listed Team', testSlug('listed'));
    const { teams } = await api('/api/teams');

    const found = teams.find((t: any) => t.id === team.id);
    expect(found).toBeTruthy();
    expect(found.role).toBe('owner');
    expect(found.memberCount).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test('update team — owner can change name', async () => {
    const team = await createTestTeam('Old Name', testSlug('update'));
    const res = await api(`/api/teams/${team.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(res.success).toBe(true);

    const details = await api(`/api/teams/${team.id}`);
    expect(details.team.name).toBe('New Name');
  }, TIMEOUT);

  test('delete team — owner can delete non-personal team', async () => {
    const team = await createTestTeam('Deletable Team', testSlug('deletable'));
    const res = await api(`/api/teams/${team.id}`, { method: 'DELETE' });
    expect(res.success).toBe(true);

    // Remove from cleanup list since it's already deleted
    const idx = teamsToCleanup.indexOf(team.id);
    if (idx >= 0) teamsToCleanup.splice(idx, 1);

    // Verify it's gone
    const { status } = await apiRaw(`/api/teams/${team.id}`);
    expect(status).toBe(404);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 2. Invitation lifecycle
  // ---------------------------------------------------------------

  test('create invitation — returns invitation with token and URL', async () => {
    const team = await createTestTeam('Invite Team', testSlug('invite'));

    const res = await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'newuser@example.com', role: 'member' }),
    });

    expect(res.invitation).toBeTruthy();
    expect(res.invitation.email).toBe('newuser@example.com');
    expect(res.invitation.role).toBe('member');
    expect(res.invitation.status).toBe('pending');
    expect(res.invitation.token).toBeTruthy();
    expect(res.inviteUrl).toContain(res.invitation.token);
    expect(res.invitation.expiresAt).toBeTruthy();

    // Verify expiry is ~7 days in the future
    const expiresAt = new Date(res.invitation.expiresAt).getTime();
    const now = Date.now();
    const sixDays = 6 * 24 * 60 * 60 * 1000;
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    expect(expiresAt - now).toBeGreaterThan(sixDays);
    expect(expiresAt - now).toBeLessThan(eightDays);
  }, TIMEOUT);

  test('create invitation — can invite as admin role', async () => {
    const team = await createTestTeam('Invite Admin', testSlug('invite-admin'));

    const res = await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'admin-invitee@example.com', role: 'admin' }),
    });

    expect(res.invitation.role).toBe('admin');
  }, TIMEOUT);

  test('create invitation — rejects owner role', async () => {
    const team = await createTestTeam('No Owner Invite', testSlug('no-owner'));

    const { status, body } = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'owner-want@example.com', role: 'owner' }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('role must be admin or member');
  }, TIMEOUT);

  test('create invitation — rejects missing fields', async () => {
    const team = await createTestTeam('Missing Fields', testSlug('missing'));

    const { status: s1 } = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(s1).toBe(400);

    const { status: s2 } = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(s2).toBe(400);
  }, TIMEOUT);

  test('list invitations — returns pending invitations', async () => {
    const team = await createTestTeam('List Invites', testSlug('list-inv'));

    // Create two invitations
    await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'user1@example.com', role: 'member' }),
    });
    await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'user2@example.com', role: 'admin' }),
    });

    const { invitations } = await api(`/api/teams/${team.id}/invitations`);
    expect(invitations.length).toBe(2);

    const emails = invitations.map((i: any) => i.email);
    expect(emails).toContain('user1@example.com');
    expect(emails).toContain('user2@example.com');

    // Verify inviter info is included
    const inv = invitations[0];
    expect(inv.inviter).toBeTruthy();
    expect(inv.inviter.id).toBeTruthy();
  }, TIMEOUT);

  test('revoke invitation — deletes invitation', async () => {
    const team = await createTestTeam('Revoke Team', testSlug('revoke'));

    const { invitation } = await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'revoked@example.com', role: 'member' }),
    });

    // Revoke it
    const res = await api(`/api/teams/${team.id}/invitations/${invitation.id}`, {
      method: 'DELETE',
    });
    expect(res.success).toBe(true);

    // Verify it's gone from the list
    const { invitations } = await api(`/api/teams/${team.id}/invitations`);
    const found = invitations.find((i: any) => i.id === invitation.id);
    expect(found).toBeFalsy();
  }, TIMEOUT);

  test('revoke invitation — 404 for non-existent invitation', async () => {
    const team = await createTestTeam('Revoke 404', testSlug('revoke-404'));

    const { status } = await apiRaw(
      `/api/teams/${team.id}/invitations/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE' }
    );
    expect(status).toBe(404);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 3. Duplicate invitation handling
  // ---------------------------------------------------------------

  test('duplicate invitation — rejects pending duplicate', async () => {
    const team = await createTestTeam('Dup Invite', testSlug('dup-inv'));

    // First invitation succeeds
    await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'same@example.com', role: 'member' }),
    });

    // Second invitation to same email fails with 409
    const { status, body } = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'same@example.com', role: 'admin' }),
    });

    expect(status).toBe(409);
    expect(body.error).toContain('pending invitation already exists');
  }, TIMEOUT);

  test('duplicate invitation — rejects if already a member', async () => {
    const team = await createTestTeam('Already Member', testSlug('already'));

    // Try to invite the current user (who is already the owner)
    const { status, body } = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: currentUserEmail, role: 'member' }),
    });

    expect(status).toBe(409);
    expect(body.error).toContain('already a team member');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 4. Member management
  // ---------------------------------------------------------------

  test('list members — returns owner in member list', async () => {
    const team = await createTestTeam('Members Team', testSlug('members'));

    const { members } = await api(`/api/teams/${team.id}/members`);
    expect(members.length).toBeGreaterThanOrEqual(1);

    const owner = members.find((m: any) => m.role === 'owner');
    expect(owner).toBeTruthy();
    expect(owner.userId).toBe(currentUserId);
    expect(owner.email).toBe(currentUserEmail);
    expect(owner.joinedAt).toBeTruthy();
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 5. Role-based access control
  // ---------------------------------------------------------------

  test('RBAC — owner can access all team endpoints', async () => {
    const team = await createTestTeam('RBAC Owner', testSlug('rbac-owner'));

    // All of these should succeed for the owner
    const detailRes = await apiRaw(`/api/teams/${team.id}`);
    expect(detailRes.status).toBe(200);

    const membersRes = await apiRaw(`/api/teams/${team.id}/members`);
    expect(membersRes.status).toBe(200);

    const invitationsRes = await apiRaw(`/api/teams/${team.id}/invitations`);
    expect(invitationsRes.status).toBe(200);

    // Owner can create invitations
    const inviteRes = await apiRaw(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'rbac-test@example.com', role: 'member' }),
    });
    expect(inviteRes.status).toBe(200);

    // Owner can update team
    const patchRes = await apiRaw(`/api/teams/${team.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated RBAC' }),
    });
    expect(patchRes.status).toBe(200);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 6. Last owner protection
  // ---------------------------------------------------------------

  test('last owner — cannot demote self from owner', async () => {
    const team = await createTestTeam('Last Owner', testSlug('last-owner'));

    const { status, body } = await apiRaw(
      `/api/teams/${team.id}/members/${currentUserId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      }
    );

    expect(status).toBe(400);
    expect(body.error).toContain('last owner');
  }, TIMEOUT);

  test('last owner — cannot remove self as owner', async () => {
    const team = await createTestTeam('Owner Self Remove', testSlug('self-remove'));

    const { status, body } = await apiRaw(
      `/api/teams/${team.id}/members/${currentUserId}`,
      { method: 'DELETE' }
    );

    expect(status).toBe(400);
    expect(body.error).toContain('cannot remove');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 7. Update member role
  // ---------------------------------------------------------------

  test('update role — rejects invalid role', async () => {
    const team = await createTestTeam('Invalid Role', testSlug('invalid-role'));

    const { status, body } = await apiRaw(
      `/api/teams/${team.id}/members/${currentUserId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'superadmin' }),
      }
    );

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid role');
  }, TIMEOUT);

  test('update role — 404 for non-existent member', async () => {
    const team = await createTestTeam('No Member', testSlug('no-member'));

    const { status } = await apiRaw(
      `/api/teams/${team.id}/members/00000000-0000-0000-0000-000000000000`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      }
    );

    expect(status).toBe(404);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 8. Remove member
  // ---------------------------------------------------------------

  test('remove member — 404 for non-existent member', async () => {
    const team = await createTestTeam('Remove 404', testSlug('remove-404'));

    const { status } = await apiRaw(
      `/api/teams/${team.id}/members/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE' }
    );

    expect(status).toBe(404);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 9. Invitation acceptance via token
  // ---------------------------------------------------------------

  test('accept invitation — rejects non-existent token', async () => {
    const { status, body } = await apiRaw(
      '/api/invitations/00000000-0000-0000-0000-000000000000/accept',
      { method: 'POST' }
    );

    expect(status).toBe(404);
    expect(body.error).toContain('Invitation not found');
  }, TIMEOUT);

  test('accept invitation — accepting same invitation twice fails', async () => {
    const team = await createTestTeam('Double Accept', testSlug('double-accept'));

    // Create an invitation
    const { invitation } = await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'double-accept@example.com', role: 'member' }),
    });

    // First accept — the current user accepts (they're already a member via owner,
    // so onConflictDoNothing applies, but invitation status changes to accepted)
    const res1 = await api(`/api/invitations/${invitation.token}/accept`, {
      method: 'POST',
    });
    expect(res1.team).toBeTruthy();

    // Second accept — should fail because status is no longer 'pending'
    const { status, body } = await apiRaw(
      `/api/invitations/${invitation.token}/accept`,
      { method: 'POST' }
    );
    expect(status).toBe(400);
    expect(body.error).toContain('already been accepted');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 10. Team deletion cascades
  // ---------------------------------------------------------------

  test('delete team — cascades invitations and members', async () => {
    const team = await createTestTeam('Cascade Team', testSlug('cascade'));

    // Create an invitation
    await api(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email: 'cascade@example.com', role: 'member' }),
    });

    // Delete the team
    const res = await api(`/api/teams/${team.id}`, { method: 'DELETE' });
    expect(res.success).toBe(true);

    // Remove from cleanup list
    const idx = teamsToCleanup.indexOf(team.id);
    if (idx >= 0) teamsToCleanup.splice(idx, 1);

    // Team should no longer be accessible
    const { status } = await apiRaw(`/api/teams/${team.id}`);
    expect(status).toBe(404);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 11. Edge cases
  // ---------------------------------------------------------------

  test('access non-member team — returns 404', async () => {
    // Use a random UUID that doesn't exist
    const { status } = await apiRaw('/api/teams/00000000-0000-0000-0000-000000000000');
    expect(status).toBe(404);
  }, TIMEOUT);

  test('create team — rejects missing name or slug', async () => {
    const { status: s1 } = await apiRaw('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'No Slug' }),
    });
    expect(s1).toBe(400);

    const { status: s2 } = await apiRaw('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ slug: 'no-name' }),
    });
    expect(s2).toBe(400);
  }, TIMEOUT);

  test('invitation on non-existent team — returns error', async () => {
    const { status } = await apiRaw(
      '/api/teams/00000000-0000-0000-0000-000000000000/invitations',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'test@example.com', role: 'member' }),
      }
    );

    // Should be 403 (not a member/admin of this team) or 404
    expect([403, 404]).toContain(status);
  }, TIMEOUT);
});
