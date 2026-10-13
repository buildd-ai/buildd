import { describe, expect, it } from 'bun:test';
import { unlinkedTokensChip } from './unlinked-tokens';

// Settings spec R-11: the chip says what a token with no workspace links can
// reach (its team's open workspaces), and warns only when that is nothing.
describe('unlinkedTokensChip', () => {
  it('is absent when every token has a link', () => {
    expect(unlinkedTokensChip(0, 3)).toBeNull();
  });

  it('says the tokens reach open workspaces, in neutral tone', () => {
    expect(unlinkedTokensChip(2, 3)).toEqual({ tone: 'idle', label: '2 on open workspaces only' });
    expect(unlinkedTokensChip(1, 1)).toEqual({ tone: 'idle', label: '1 on open workspaces only' });
  });

  it('warns when the team has no open workspace for them to reach', () => {
    expect(unlinkedTokensChip(1, 0)).toEqual({ tone: 'warn', label: '1 reaches no workspace' });
    expect(unlinkedTokensChip(3, 0)).toEqual({ tone: 'warn', label: '3 reach no workspace' });
  });
});
