import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
const { stripReason } = await import('./MissionTaskStrip');

// The focus card says what the card and header say (visual review round 4): a ready
// task on a runner mission is "Next in line for a runner", never "next free slot".
describe('stripReason for a ready task', () => {
  const ready = { status: 'ready' } as Parameters<typeof stripReason>[0];
  it('matches the shared hold wording on a runner mission', () => {
    expect(stripReason(ready, 'runner')).toBe('Next in line for a runner.');
    expect(stripReason(ready, null)).toBe('Next in line for a runner.');
  });
  it('a local mission asks for a local claim', () => {
    expect(stripReason(ready, 'local')).toBe('Ready to start. Claim it from your session.');
  });
});
