import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import GettingStartedChecklist from './GettingStartedChecklist';
import { gettingStartedChecklist } from '@/lib/getting-started';

function render(input: Parameters<typeof gettingStartedChecklist>[0], chatSetupHref?: string | null) {
  return renderToStaticMarkup(<GettingStartedChecklist checklist={gettingStartedChecklist(input)} chatSetupHref={chatSetupHref} />);
}

describe('GettingStartedChecklist', () => {
  it('a new team sees all three steps, the runner commands and the key options', () => {
    const html = render({ runnerConnected: false, hasAgentCredential: false, hasTask: false });
    expect(html).toContain('Get started · 0 of 3');
    expect(html).toContain('Connect a runner');
    expect(html).toContain('buildd login');
    expect(html).toContain('Add an agent key');
    expect(html).toContain('/app/settings/runners#agent-backends');
    expect(html).toContain('OpenRouter');
    expect(html).toContain('LiteLLM');
    expect(html).toContain('File a first task');
    expect(html).not.toMatch(/subscription/i);
  });

  it('a done step folds to its title with a Done chip, and loses its instructions', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: false, hasTask: true });
    expect(html).toContain('Get started · 2 of 3');
    expect(html).toContain('data-testid="getting-started-runner" data-done="true"');
    expect(html).not.toContain('buildd login');
    expect(html).toMatch(/data-testid="getting-started-credential" data-done="false" aria-current="step"/);
    expect(html).toContain('Done');
  });

  it('folds chat setup into one footer line when asked', () => {
    expect(render({ runnerConnected: false, hasAgentCredential: false, hasTask: false }, '/app/settings/providers')).toContain('Model providers');
    expect(render({ runnerConnected: false, hasAgentCredential: false, hasTask: false })).not.toContain('Model providers');
  });
});
