import { describe, expect, it } from 'bun:test';
import { buildParamsDescription } from '../mcp-tools';

describe('mission control MCP descriptions', () => {
  const manageMissions = buildParamsDescription(['manage_missions']);
  const createTask = buildParamsDescription(['create_task']);

  it('states hold, organizer, and pacing defaults with decision guidance', () => {
    expect(manageMissions).toContain('startMode default: "armed"');
    expect(manageMissions).toContain('"held" blocks normal linked task claims until action="arm"');
    expect(manageMissions).toContain('orchestrationMode default: "auto"');
    expect(manageMissions).toContain('"manual" skips the organizer');
    expect(manageMissions).toContain('pacingMode default: "eager"');
    expect(manageMissions).toContain('"paced" spaces task starts');
    expect(manageMissions).toContain('pacingMaxPerHour default: 1');
  });

  it('explains the safe pre-filed-chain sequence and intentional pending states', () => {
    expect(createTask).toContain('Pre-filed chain');
    expect(createTask).toContain('create the mission held');
    expect(createTask).toContain('then arm it');
    expect(createTask).toContain('inherits hold and pacing gates');
    expect(createTask).toContain('pending is intentional');
  });
});
