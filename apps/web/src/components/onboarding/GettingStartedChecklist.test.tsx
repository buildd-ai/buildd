import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import GettingStartedChecklist from './GettingStartedChecklist';
import { gettingStartedChecklist } from '@/lib/getting-started';

function render(input: Parameters<typeof gettingStartedChecklist>[0], chatSetupHref?: string | null) {
  return renderToStaticMarkup(<GettingStartedChecklist checklist={gettingStartedChecklist(input)} chatSetupHref={chatSetupHref} />);
}

describe('GettingStartedChecklist', () => {
  it('a new team sees all three steps, the runner commands and the key options', () => {
    const html = render({ runnerConnected: false, hasAgentCredential: false, firstTask: 'none' });
    expect(html).toContain('Get started · 0 of 3');
    expect(html).toContain('Connect a runner');
    // The one install sequence (lib/runner-install.ts): reload the shell, log in, start.
    // Nothing serves localhost:8766 unless the runner runs with --debug.
    expect(html).toContain('exec $SHELL');
    expect(html).toContain('buildd login');
    expect(html).toContain('buildd login --device');
    expect(html).not.toContain('8766');
    expect(html).toContain('Add an agent key');
    expect(html).toContain('/app/settings/runners#agent-key');
    expect(html).toContain('OpenRouter');
    expect(html).toContain('LiteLLM');
    expect(html).toContain('Run a first task');
    expect(html).not.toMatch(/subscription/i);
  });

  it('a done step folds to its title with a Done chip, and loses its instructions', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: false, firstTask: 'done' });
    expect(html).toContain('Get started · 2 of 3');
    expect(html).toContain('data-testid="getting-started-runner" data-done="true"');
    expect(html).not.toContain('exec $SHELL');
    expect(html).toMatch(/data-testid="getting-started-credential" data-done="false" aria-current="step"/);
    expect(html).toContain('Done');
  });

  it('folds chat setup into one footer line when asked', () => {
    expect(render({ runnerConnected: false, hasAgentCredential: false, firstTask: 'none' }, '/app/settings/providers')).toContain('Model providers');
    expect(render({ runnerConnected: false, hasAgentCredential: false, firstTask: 'none' })).not.toContain('Model providers');
  });

  it('a failed first task keeps the step open and says where the reason is', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: true, firstTask: 'failed' });
    expect(html).toContain('Get started · 2 of 3');
    expect(html).toMatch(/data-testid="getting-started-task" data-done="false" aria-current="step"/);
    expect(html).toContain('Your first task failed');
    expect(html).toContain('Needs you');
  });

  it('a first task still running says so instead of asking for a new one', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: true, firstTask: 'open' });
    expect(html).toContain('Your first task is queued or running');
  });
});

describe('GettingStartedChecklist — nearly done', () => {
  it('collapses to one line naming the last step once 2 of 3 are done', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: false, firstTask: 'done' });
    expect(html).toContain('data-collapsed="true"');
    expect(html).toMatch(/<details[^>]*data-testid="getting-started"/);
    expect(html).toMatch(/<summary[^>]*>.*Get started · 2 of 3.*Next: Add an agent key.*<\/summary>/);
    // The how-to stays one click away, not gone.
    expect(html).toContain('Add an Anthropic key');
  });

  it('stays open as a full list while fewer than 2 steps are done', () => {
    const html = render({ runnerConnected: true, hasAgentCredential: false, firstTask: 'none' });
    expect(html).not.toContain('data-collapsed="true"');
    expect(html).not.toContain('<details');
  });
});
