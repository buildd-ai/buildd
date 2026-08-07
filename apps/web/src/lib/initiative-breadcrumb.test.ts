/**
 * Tests for initiative→mission breadcrumb injection helpers.
 *
 * Feature (I-5): when navigating from an initiative detail page to a child
 * mission, the URL carries `?from=initiative&initiativeId=<id>` so the
 * mission detail page can render the three-level breadcrumb:
 *
 *   Initiatives / {initiative.title} / {mission.title}
 *
 * Feature (I-8): even when navigating directly to a mission (no URL params),
 * the breadcrumb shows the parent initiative when the mission has one in DB:
 *
 *   Initiatives / {initiative.title} / {mission.title}
 *
 * Missions with no initiative always fall back to the two-level default:
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
// resolveMissionBreadcrumb — URL param path (existing behaviour)
// ---------------------------------------------------------------------------

describe('resolveMissionBreadcrumb — URL param path', () => {
  it('returns initiative breadcrumb when from=initiative and initiativeId + name are present', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-123',
      initiativeName: 'Auth Hardening',
      dbInitiativeId: null,
      dbInitiativeName: null,
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

  it('returns default missions breadcrumb when from param is absent and no DB initiative', () => {
    const crumb = resolveMissionBreadcrumb({
      from: undefined,
      initiativeId: undefined,
      initiativeName: undefined,
      dbInitiativeId: null,
      dbInitiativeName: null,
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
      dbInitiativeId: null,
      dbInitiativeName: null,
      missionTitle: 'Add MFA',
    });
    expect(crumb).toEqual({
      type: 'missions',
      links: [{ label: 'Missions', href: '/app/missions' }],
      currentLabel: 'Add MFA',
    });
  });

  it('returns default missions breadcrumb when from param has unexpected value and no DB initiative', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'some-other-value',
      initiativeId: 'initiative-123',
      initiativeName: 'Auth Hardening',
      dbInitiativeId: null,
      dbInitiativeName: null,
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
      dbInitiativeId: null,
      dbInitiativeName: null,
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
      dbInitiativeId: null,
      dbInitiativeName: null,
      missionTitle: 'Profile DB queries',
    });
    expect(crumb.currentLabel).toBe('Profile DB queries');
  });

  it('falls back to DB initiative when URL initiativeName is empty string', () => {
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-abc',
      initiativeName: '',
      dbInitiativeId: 'initiative-db',
      dbInitiativeName: 'DB Initiative',
      missionTitle: 'Profile DB queries',
    });
    // URL path fails (empty name), falls back to DB
    expect(crumb.type).toBe('initiative');
    if (crumb.type === 'initiative') {
      expect(crumb.links[1].label).toBe('DB Initiative');
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMissionBreadcrumb — DB-stored initiative path (new behaviour)
// ---------------------------------------------------------------------------

describe('resolveMissionBreadcrumb — DB-stored initiative path', () => {
  it('shows initiative breadcrumb on direct navigation when mission has DB initiative', () => {
    const crumb = resolveMissionBreadcrumb({
      from: undefined,
      initiativeId: undefined,
      initiativeName: undefined,
      dbInitiativeId: 'initiative-db-1',
      dbInitiativeName: 'Platform Reliability',
      missionTitle: 'Reduce p99 latency',
    });
    expect(crumb).toEqual({
      type: 'initiative',
      links: [
        { label: 'Initiatives', href: '/app/initiatives' },
        { label: 'Platform Reliability', href: '/app/initiatives/initiative-db-1' },
      ],
      currentLabel: 'Reduce p99 latency',
    });
  });

  it('URL param takes priority over DB initiative', () => {
    // User navigated from initiative A, but mission is now assigned to initiative B in DB.
    // Navigation context (URL) should win.
    const crumb = resolveMissionBreadcrumb({
      from: 'initiative',
      initiativeId: 'initiative-url',
      initiativeName: 'URL Initiative',
      dbInitiativeId: 'initiative-db',
      dbInitiativeName: 'DB Initiative',
      missionTitle: 'Some mission',
    });
    expect(crumb.type).toBe('initiative');
    if (crumb.type === 'initiative') {
      expect(crumb.links[1].label).toBe('URL Initiative');
      expect(crumb.links[1].href).toBe('/app/initiatives/initiative-url');
    }
  });

  it('shows default missions breadcrumb when no URL param and no DB initiative', () => {
    const crumb = resolveMissionBreadcrumb({
      from: undefined,
      initiativeId: undefined,
      initiativeName: undefined,
      dbInitiativeId: null,
      dbInitiativeName: null,
      missionTitle: 'Standalone mission',
    });
    expect(crumb).toEqual({
      type: 'missions',
      links: [{ label: 'Missions', href: '/app/missions' }],
      currentLabel: 'Standalone mission',
    });
  });

  it('shows default missions breadcrumb when DB initiative ID present but name is missing', () => {
    const crumb = resolveMissionBreadcrumb({
      from: undefined,
      initiativeId: undefined,
      initiativeName: undefined,
      dbInitiativeId: 'initiative-db-1',
      dbInitiativeName: null,
      missionTitle: 'Some mission',
    });
    expect(crumb.type).toBe('missions');
  });
});
