import { describe, it, expect } from 'bun:test';
import { refreshResultMessage, capabilityToggleCopy } from './AgentBackendsSection';

// The Claude and Codex credential cards both POST to
// /api/workspaces/[id]/{claude,codex}-credential/refresh. That route rejects a
// control-plane-originated refresh with 503 + { error, detail } unless
// BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true, so the handler has to look at res.ok
// before it looks at data.status — switching on status alone reported
// "No credential to refresh." for a credential that was in fact connected.

describe('refreshResultMessage', () => {
  describe('failed response (!ok) — render what the route sent', () => {
    it('surfaces error and detail from a rejected control-plane refresh', () => {
      const msg = refreshResultMessage(false, {
        status: 'control_plane_refresh_disabled',
        error: 'Token refresh is runner-originated and cannot be triggered from the dashboard.',
        detail: 'A runner holding the credential lease refreshes it automatically as it nears expiry.',
      });
      expect(msg.type).toBe('error');
      expect(msg.text).toContain('runner-originated');
      expect(msg.text).toContain('nears expiry');
    });

    it('does not fall through to the no-credential message when the body has a status field', () => {
      const msg = refreshResultMessage(false, {
        status: 'control_plane_refresh_disabled',
        error: 'Token refresh is runner-originated and cannot be triggered from the dashboard.',
      });
      expect(msg.text).not.toContain('No credential');
    });

    it('renders error alone when the route sends no detail', () => {
      const msg = refreshResultMessage(false, { error: 'Something specific went wrong' });
      expect(msg).toEqual({ type: 'error', text: 'Something specific went wrong' });
    });

    it('falls back to a generic message when the body carries no usable text', () => {
      expect(refreshResultMessage(false, {})).toEqual({ type: 'error', text: 'Failed to refresh token' });
      expect(refreshResultMessage(false, null)).toEqual({ type: 'error', text: 'Failed to refresh token' });
    });

    it('ignores a success-shaped status on a failed response', () => {
      const msg = refreshResultMessage(false, { status: 'refreshed', error: 'Refresh is disabled here' });
      expect(msg.type).toBe('error');
      expect(msg.text).toBe('Refresh is disabled here');
    });
  });

  describe('successful response (ok) — existing status branches are unchanged', () => {
    it('reports a completed refresh', () => {
      expect(refreshResultMessage(true, { status: 'refreshed' }))
        .toEqual({ type: 'success', text: 'Token refreshed.' });
    });

    it('treats a held refresh lock as success', () => {
      expect(refreshResultMessage(true, { status: 'locked' }))
        .toEqual({ type: 'success', text: 'Token was refreshed recently.' });
    });

    it('reports a helper-level refresh failure as a possibly-invalid credential', () => {
      const msg = refreshResultMessage(true, { status: 'error' });
      expect(msg.type).toBe('error');
      expect(msg.text).toContain('may be invalid');
    });

    it('reports no_credential', () => {
      expect(refreshResultMessage(true, { status: 'no_credential' }))
        .toEqual({ type: 'error', text: 'No credential to refresh.' });
    });

    it('treats an unrecognised status as no_credential, as before', () => {
      expect(refreshResultMessage(true, { status: 'something_new' }).type).toBe('error');
      expect(refreshResultMessage(true, null).type).toBe('error');
    });
  });
});

// The chat capability is a feature switch, not a cost/latency trade: there is no
// agent path for a chat turn. "Use agent" / "Use inference" would misdescribe it.
describe('capabilityToggleCopy', () => {
  const chat = { id: 'chat', label: 'Chat', description: 'd', fallback: 'none' as const, costHint: '~$0.01 per turn' };
  const grading = { id: 'criteria_grading', label: 'Goal criteria grading', description: 'd', fallback: 'agent' as const, costHint: '~$0.001' };

  it('labels chat as a plain on/off switch', () => {
    expect(capabilityToggleCopy(chat, false).button).toBe('Turn on chat');
    expect(capabilityToggleCopy(chat, true).button).toBe('Turn off chat');
    expect(capabilityToggleCopy(chat, false).meta).toBe('off');
    expect(capabilityToggleCopy(chat, true).meta).toBe('on · ~$0.01 per turn');
  });

  it('tells you chat needs a provider key, since the toggle alone spends nothing', () => {
    expect(capabilityToggleCopy(chat, true).needsKeyHint).toBe(true);
    expect(capabilityToggleCopy(grading, true).needsKeyHint).toBe(false);
  });

  it('keeps the agent/inference wording for everything else', () => {
    expect(capabilityToggleCopy(grading, false)).toMatchObject({ button: 'Use inference', meta: 'agent run' });
    expect(capabilityToggleCopy(grading, true)).toMatchObject({ button: 'Use agent', meta: 'inference · ~$0.001' });
  });

  it('writes the result message in active voice, no em dashes', () => {
    const msgs = [
      capabilityToggleCopy(chat, false).turnedOn, capabilityToggleCopy(chat, true).turnedOff,
      capabilityToggleCopy(grading, false).turnedOn, capabilityToggleCopy(grading, true).turnedOff,
    ];
    for (const m of msgs) expect(m).not.toContain('\u2014');
    expect(capabilityToggleCopy(chat, false).turnedOn).toMatch(/Chat is on/);
  });
});
