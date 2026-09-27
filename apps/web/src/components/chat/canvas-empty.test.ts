import { describe, expect, it } from 'bun:test';
import { canvasGreeting, canvasSuggestions } from './canvas-empty';

describe('canvasGreeting', () => {
  it('greets by first name, and without one', () => {
    expect(canvasGreeting('Maya')).toBe('Hi Maya, what are we working on?');
    expect(canvasGreeting(null)).toBe('Hi, what are we working on?');
  });

  it('speaks to the object the chat was opened about', () => {
    expect(canvasGreeting('Maya', { kind: 'mission', title: 'Multi-currency invoices' })).toBe('Ask anything about Multi-currency invoices.');
    expect(canvasGreeting('Maya', { kind: 'task', title: null })).toBe('Ask anything about this task.');
  });
});

describe('canvasSuggestions', () => {
  it('a plain new chat offers everyday questions, sent in one tap, plus a starter that only fills the box', () => {
    const s = canvasSuggestions({ intent: null, about: null });
    expect(s.map(x => x.label)).toEqual(['What needs me?', "What's running right now?", 'What shipped this week?', 'Start something new']);
    expect(s.slice(0, 3).every(x => x.send)).toBe(true);
    expect(s[3].send).toBe(false);
  });

  it('about a mission or a task: questions about that object', () => {
    expect(canvasSuggestions({ intent: null, about: 'mission' }).map(x => x.label)).toEqual(['How is it going?', "What's holding it up?", "What's left?"]);
    expect(canvasSuggestions({ intent: null, about: 'task' }).map(x => x.label)).toEqual(['Where is it at?', "What's it doing now?"]);
  });

  it('opened to start a mission or a task: no suggestions, the placeholder already asks', () => {
    expect(canvasSuggestions({ intent: 'mission', about: null })).toEqual([]);
    expect(canvasSuggestions({ intent: 'task', about: null })).toEqual([]);
  });
});
