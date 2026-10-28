import { describe, expect, it } from 'bun:test';
import { STATE_KEYS, STATES } from '@/components/ui/states';
import { stripDrawerPill } from './MissionTaskStrip';

const STRIP = ['landed', 'review', 'running', 'waiting', 'ci_failed', 'fixing', 'failed', 'ready', 'blocked', 'queued'] as const;

describe('strip drawer pill words', () => {
  it('reads the shared state table for every strip state', () => {
    for (const s of STRIP) {
      expect(STATE_KEYS).toContain(s);
      expect(stripDrawerPill({ delivery: null } as never, s, 'runner')).toBe(STATES[s].word);
    }
  });

  it('keeps the local-executor claim word for a ready task', () => {
    expect(stripDrawerPill({ delivery: null } as never, 'ready', 'local')).toBe('Needs claim');
  });
});
