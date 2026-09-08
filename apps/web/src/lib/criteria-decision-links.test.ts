import { describe, it, expect } from 'bun:test';
import { buildFileWorkHref } from './criteria-decision-links';

describe('buildFileWorkHref', () => {
  it('scopes the task composer to the mission and prefills the failing criterion', () => {
    const href = buildFileWorkHref({
      missionId: 'mission-1',
      missionTitle: 'Payments rollout',
      criterion: { type: 'command', command: 'bun test' },
      evidence: 'command exited 1',
    });
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/app/tasks/new');
    expect(url.searchParams.get('missionId')).toBe('mission-1');
    expect(url.searchParams.get('title')).toContain('bun test');
    expect(url.searchParams.get('description')).toContain('bun test');
    expect(url.searchParams.get('description')).toContain('command exited 1');
  });

  it('falls back to the mission title when there is no criterion to name', () => {
    const href = buildFileWorkHref({ missionId: 'mission-2', missionTitle: 'Payments rollout', criterion: null });
    const url = new URL(href, 'http://localhost');
    expect(url.searchParams.get('title')).toContain('Payments rollout');
    expect(url.searchParams.get('description')).toBeNull();
  });

  it('prefers the criterion label over its raw command text', () => {
    const href = buildFileWorkHref({
      missionId: 'mission-3',
      missionTitle: null,
      criterion: { type: 'command', command: 'bun test', label: 'Test suite green' },
    });
    const url = new URL(href, 'http://localhost');
    expect(url.searchParams.get('title')).toContain('Test suite green');
  });
});
