/**
 * One status → colour mapping (brand: orange = moving / in progress, green =
 * done / success). RUNNING was green on the mission page and orange on Home;
 * every surface now reads its colour from `status-tone.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_TONE_CHIP, STATUS_TONE_EDGE, STATUS_TONE_SQUARE, STATUS_TONE_TEXT, missionStateTone } from './status-tone';
import { getMissionStateChip, type MissionDisplayState } from './mission-helpers';

describe('status tone', () => {
  it('moving is orange, done is green', () => {
    expect(missionStateTone('running')).toBe('accent');
    expect(missionStateTone('complete')).toBe('success');
    expect(STATUS_TONE_CHIP.accent).toContain('accent');
    expect(STATUS_TONE_CHIP.success).toContain('status-success');
  });

  it('the mission page chip reads RUNNING in the progress colour, not green', () => {
    const chip = getMissionStateChip('running');
    expect(chip.label).toBe('RUNNING');
    expect(chip.cls).toBe(STATUS_TONE_CHIP.accent);
    expect(chip.cls).not.toContain('status-success');
  });

  it('a finished mission reads in the success colour', () => {
    expect(getMissionStateChip('complete').cls).toBe(STATUS_TONE_CHIP.success);
  });

  it('every display state takes its chip classes from the one mapping', () => {
    const states: MissionDisplayState[] = ['held', 'blocked', 'stalled', 'running', 'failed', 'review', 'awaiting_verification', 'waiting_decision', 'manual', 'complete', 'active'];
    for (const s of states) expect(getMissionStateChip(s).cls).toBe(STATUS_TONE_CHIP[missionStateTone(s)]);
  });

  it('the list cards (Home, Missions) use the same maps instead of their own', () => {
    const src = readFileSync(join(import.meta.dir, '../components/missions/MissionListCards.tsx'), 'utf8');
    expect(src).toContain("from '@/lib/status-tone'");
    expect(src).not.toMatch(/const TONE_(TEXT|SQUARE|EDGE)\s*:/);
    expect(STATUS_TONE_TEXT.accent).toBe('text-accent-text');
    expect(STATUS_TONE_SQUARE.accent).toBe('bg-accent');
    expect(STATUS_TONE_EDGE.success).toBe('border-l-status-success');
  });
});
