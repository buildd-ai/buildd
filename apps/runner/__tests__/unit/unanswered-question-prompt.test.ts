import { describe, it, expect } from 'bun:test';
import { renderUnansweredQuestion } from '../../src/prompt-builder';

// The waiting-input sweep requeues the same task and keeps its description;
// "do not ask again" is rendered from context.unansweredQuestion instead.
describe('renderUnansweredQuestion', () => {
  it('renders nothing when the task carries no unanswered question', () => {
    expect(renderUnansweredQuestion(undefined)).toBeNull();
    expect(renderUnansweredQuestion(null)).toBeNull();
  });

  it('names the question and its options and tells the attempt not to ask for input', () => {
    const out = renderUnansweredQuestion({ prompt: 'Which database?', options: ['PostgreSQL', 'MySQL'] })!;
    expect(out).toContain('Which database?');
    expect(out).toContain('PostgreSQL, MySQL');
    expect(out).toContain('Do NOT ask for user input');
  });

  it('still carries the guidance when the question text was not kept', () => {
    expect(renderUnansweredQuestion({ prompt: null, options: [] })).toContain('Do NOT ask for user input');
  });
});
