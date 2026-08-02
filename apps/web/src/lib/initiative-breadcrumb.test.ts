/**
 * Tests for initiative→mission breadcrumb injection helpers.
 *
 * Feature (I-5): when navigating from an initiative detail page to a child
 * mission, the URL carries `?from=initiative&initiativeId=<id>` so the
 * mission detail page can render the three-level breadcrumb:
 *
 *   Initiatives / {initiative.title} / {mission.title}
 *
 * Direct navigation to a mission (no params) renders the standard two-level
 * breadcrumb:
 *
 *   Missions / {mission.title}
 */

import { describe, it, expect } from 'bun:test';
import { buildMissionWithInitiativeUrl, resolveMissionBreadcrumb } from './initiative-breadcrumb';

// ---------------------------------------------------------------------------
// buildMissionWithInitiativeUrl
// ---------------------------------------------------------------------------

describe('buildMissionWithInitiativeUrl', () => {
  it('appends from=initiative and initiativeId query params', () => {
    const url = buildMissionWithInitiativeUrl('mission-abc', 'initiative-123');
    expect(url).toBe('/app/missions/mission-abc?from=initiative&initiativeId=initiative-123');
  });

  it('handles UUID-format ids without mangling them', () => {
    const missionId = 'bf442fcb-6179-43b3-aa92-2564b1ad24b8';
    const initiativeId = '2ea93630-18dd-473b-9c07-6f9b224c01d3';
    const url = buildMissionWithInitiativeUrl(missionId, initiativeId);
    expect(url).toBe(`/app/missions/${missionId}?from=initiative&initiativeId=${initiativeId}`);
  });
});

// ---------------------------------------------------------------------------
// resolveMissionBreadcrumb
// ---------------------------------------------------------------------------

describe('resolveMissionBreadcrumb', () => {
  it('returns initiative breadcrumb when from=initiative and initiativeId + name are present', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-123',
      initiativeName: 'Auth Hardening',
      missionTitle: 'Add MFA',
    });
    expect(crumb).toEqual({
      type: 'initiative',
      links: [
        { label: 'Initiatives', href: '/app/initiatives' },
        { label: 'Auth Hardening', href: '/app/initiatives/initiative-123' },
      ],
      currentLabel: 'Add MFA',
    });
  });

  it('returns default missions breadcrumb when from param is absent', () => {
    const crumb = resolveMissionBreadcrumb({
      from: undefined,
      initiativeId: undefined,
      initiativeName: undefined,
      missionTitle: 'Add MFA',
    });
    expect(crumb).toEqual({
      type: 'missions',
      links: [{ label: 'Missions', href: '/app/missions' }],
      currentLabel: 'Add MFA',
    });
  });

  it('returns default missions breadcrumb when from=initiative but initiativeId is missing', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: undefined,
      initiativeName: undefined,
      missionTitle: 'Add MFA',
    });
    expect(crumb).toEqual({
      type: 'missions',
      links: [{ label: 'Missions', href: '/app/missions' }],
      currentLabel: 'Add MFA',
    });
  });

  it('returns default missions breadcrumb when from param has unexpected value', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'some-other-value',
      initiativeId: 'initiative-123',
      initiativeName: 'Auth Hardening',
      missionTitle: 'Add MFA',
    });
    expect(crumb).toEqual({
      type: 'missions',
      links: [{ label: 'Missions', href: '/app/missions' }],
      currentLabel: 'Add MFA',
    });
  });

  it('uses the initiative name in the breadcrumb link label', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-abc',
      initiativeName: 'Q3 Performance',
      missionTitle: 'Profile DB queries',
    });
    if (crumb.type !== 'initiative') throw new Error('expected initiative type');
    const initiativeLink = crumb.links[1];
    expect(initiativeLink.label).toBe('Q3 Performance');
    expect(initiativeLink.href).toBe('/app/initiatives/initiative-abc');
  });

  it('uses the mission title as the current (non-linked) label', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-abc',
      initiativeName: 'Q3 Performance',
      missionTitle: 'Profile DB queries',
    });
    expect(crumb.currentLabel).toBe('Profile DB queries');
  });

  it('falls back to missions breadcrumb when initiativeName is empty string', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-abc',
      initiativeName: '',
      missionTitle: 'Profile DB queries',
    });
    expect(crumb.type).toBe('missions');
  });
});
