import { describe, it, expect, mock } from 'bun:test';
import { detectInteractiveSessionAsk } from '../interactive-session-ask';
import { handleBuilddAction, type ApiFn } from '../mcp-tools';

describe('interactive session ask', () => {
  it('catches the option that does nothing', () => {
    expect(detectInteractiveSessionAsk('Audit from visual inspection only?', undefined,
      'Pause and request an interactive session where OAuth can be completed')).toBe(true);
    expect(detectInteractiveSessionAsk('Should I wait for an interactive session?')).toBe(true);
    expect(detectInteractiveSessionAsk('Sign-in can be completed only by a person')).toBe(true);
  });
  it('leaves ordinary questions alone', () => {
    expect(detectInteractiveSessionAsk('Which base branch should I use?', 'The session cookie expires hourly', 'dev', 'main')).toBe(false);
    expect(detectInteractiveSessionAsk('Should the login page keep the interactive tour?')).toBe(false);
  });

  it('ask_human refuses it, parks nothing, and points at get_artifact', async () => {
    const api = mock(async () => ({}));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'ask_human', {
      question: 'Blocked on the design link.', workerId: 'w1',
      options: [{ label: 'Visual inspection only' }, { label: 'Request an interactive session where OAuth can be completed' }],
    }, { workerId: 'w1', workspaceId: 'ws', getWorkspaceId: async () => 'ws', getLevel: async () => 'worker' } as never);
    expect(res.isError).toBe(true);
    const out = JSON.parse(res.content[0].text);
    expect(out.error).toBe('interactive_session_unavailable');
    expect(out.reason).toContain('get_artifact');
    expect(api).not.toHaveBeenCalled();
  });
});
