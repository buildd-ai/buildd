import { describe, expect, it } from 'bun:test';
import { canvasGreeting, canvasHero, canvasMood, canvasPlaceholder, canvasSuggestions, needsYouAction, pickedStatus, pulseNeedsYou, type CanvasPulse } from './canvas-empty';

const CALM: CanvasPulse = { needsYou: [], live: 0 };
const CALM_BUSY: CanvasPulse = { needsYou: [], live: 3 };
const ONE: CanvasPulse = { needsYou: [{ title: 'Round per line, or only the total?' }], live: 2 };
const TWO: CanvasPulse = { needsYou: [{ title: 'Pick a currency' }, { title: 'Approve the plan' }], live: 0 };
const PLAIN = { intent: null, about: null } as const;
// A Sunday morning, pinned to UTC so the overline is stable.
const NOW = new Date('2026-09-27T08:30:00Z');

/** Anything that would ask about, or imply, something waiting on the viewer. */
const NEEDS_WORDS = /needs? (me|you)|waiting on me|blocked|answer/i;

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

describe('canvasMood', () => {
  it('is needs-you exactly when something waits on the viewer, else calm', () => {
    expect(canvasMood(CALM)).toBe('calm');
    expect(canvasMood(CALM_BUSY)).toBe('calm');
    expect(canvasMood(ONE)).toBe('needs');
    expect(canvasMood(TWO)).toBe('needs');
  });

  it('is unknown without a pulse (the summoned canvas does not load one)', () => {
    expect(canvasMood(null)).toBeNull();
  });
});

describe('canvasHero', () => {
  it('calm: all quiet, and says nothing is waiting', () => {
    const h = canvasHero({ pulse: CALM, name: 'Maya', now: NOW, timeZone: 'UTC' });
    expect(h.mood).toBe('calm');
    expect(h.overline).toBe('SUN 27 SEP · CALM');
    expect(h.hero).toBe('All quiet.');
    expect(h.sub).toBe('Nothing is waiting on you. A good morning to start something.');
  });

  it('calm with agents at work: counts them, never invents', () => {
    expect(canvasHero({ pulse: CALM_BUSY, name: null, now: NOW, timeZone: 'UTC' }).sub).toBe('Nothing is waiting on you. 3 agents are at work on their own.');
    expect(canvasHero({ pulse: { needsYou: [], live: 1 }, name: null, now: NOW, timeZone: 'UTC' }).sub).toBe('Nothing is waiting on you. 1 agent is at work on its own.');
  });

  it('needs you: names the one thing', () => {
    const h = canvasHero({ pulse: ONE, name: 'Maya', now: NOW, timeZone: 'UTC' });
    expect(h.mood).toBe('needs');
    expect(h.overline).toBe('SUN 27 SEP · NEEDS YOU');
    expect(h.hero).toBe('One thing needs you.');
    expect(h.sub).toBe('“Round per line, or only the total?” is waiting on your answer.');
  });

  it('needs you, several: counts in words, and does not claim an exact count past the loader limit', () => {
    expect(canvasHero({ pulse: TWO, name: null, now: NOW, timeZone: 'UTC' }).hero).toBe('Two things need you.');
    expect(canvasHero({ pulse: TWO, name: null, now: NOW, timeZone: 'UTC' }).sub).toBe('“Pick a currency” and 1 more are waiting on you.');
    const capped = canvasHero({ pulse: { ...TWO, needsYouCapped: true }, name: null, now: NOW, timeZone: 'UTC' });
    expect(capped.hero).toBe('Several things need you.');
    expect(capped.sub).toBe('“Pick a currency” and more are waiting on you.');
  });

  it('no pulse: the plain greeting, no mood claimed', () => {
    const h = canvasHero({ pulse: null, name: 'Maya', now: NOW, timeZone: 'UTC' });
    expect(h.mood).toBeNull();
    expect(h.overline).toBe('SUN 27 SEP');
    expect(h.hero).toBe('Hi Maya, what are we working on?');
    expect(h.sub).not.toMatch(NEEDS_WORDS);
  });

  it('about an object: asks about it, with no fleet sub-line', () => {
    const h = canvasHero({ pulse: ONE, name: 'Maya', about: { kind: 'mission', title: 'Invoices' }, now: NOW, timeZone: 'UTC' });
    expect(h.hero).toBe('Ask anything about Invoices.');
    expect(h.sub).toBeNull();
  });
});

describe('canvasSuggestions: a plain new chat (PICKED FOR YOU)', () => {
  it('is always exactly two rows', () => {
    for (const p of [CALM, CALM_BUSY, ONE, TWO, { ...TWO, needsYouCapped: true }, null]) {
      expect(canvasSuggestions(PLAIN, p)).toHaveLength(2);
    }
  });

  it('never offers a needs-you prompt when nothing needs you', () => {
    for (const p of [CALM, CALM_BUSY, null]) {
      for (const s of canvasSuggestions(PLAIN, p)) {
        expect(s.label).not.toMatch(NEEDS_WORDS);
        expect(s.text).not.toMatch(NEEDS_WORDS);
        expect(s.tone).toBeUndefined();
      }
    }
  });

  it('needs you: row 1 is the thing waiting, copper, and sends in one tap', () => {
    const [first, second] = canvasSuggestions(PLAIN, ONE);
    expect(first).toEqual({
      label: 'Answer the waiting question',
      text: 'What does "Round per line, or only the total?" need from me?',
      send: true,
      tone: 'needs',
    });
    expect(second.tone).toBeUndefined();
    expect(second.label).toBe("What's running right now?");
  });

  it('needs you, several: row 1 walks through all of them', () => {
    expect(canvasSuggestions(PLAIN, TWO)[0]).toMatchObject({ label: 'Walk me through the 2 things waiting on me', text: 'What needs me right now?', tone: 'needs' });
    expect(canvasSuggestions(PLAIN, { ...TWO, needsYouCapped: true })[0].label).toBe("Walk me through what's waiting on me");
  });

  it('calm with agents at work: check on them, then start something', () => {
    const s = canvasSuggestions(PLAIN, CALM_BUSY);
    expect(s.map(x => x.label)).toEqual(['What are the 3 agents working on?', 'Start something new']);
    expect(s[0].send).toBe(true);
    expect(s[1]).toMatchObject({ send: false, text: 'I want to build ' });
  });

  it('calm and idle: start something leads', () => {
    expect(canvasSuggestions(PLAIN, CALM).map(x => x.label)).toEqual(['Start something new', 'What shipped this week?']);
  });

  it('shortens a long waiting title in the row, not in what it sends', () => {
    const long = 'x'.repeat(80);
    const [first] = canvasSuggestions(PLAIN, { needsYou: [{ title: long }], live: 0 });
    expect(first.label.length).toBeLessThan(70);
    expect(first.text).toContain(long);
  });

  it('plain language: no CI, PR or tool jargon', () => {
    for (const p of [CALM, CALM_BUSY, ONE, TWO]) {
      for (const s of canvasSuggestions(PLAIN, p)) expect(s.label).not.toMatch(/\b(CI|PRs?|MCP|worker)\b/);
    }
  });
});

describe('canvasSuggestions: scoped chats', () => {
  it('about a mission or a task: questions about that object', () => {
    expect(canvasSuggestions({ intent: null, about: 'mission' }, ONE).map(x => x.label)).toEqual(['How is it going?', "What's holding it up?", "What's left?"]);
    expect(canvasSuggestions({ intent: null, about: 'task' }).map(x => x.label)).toEqual(['Where is it at?', "What's it doing now?"]);
  });

  it('opened to start a mission or a task: no suggestions, the placeholder already asks', () => {
    expect(canvasSuggestions({ intent: 'mission', about: null }, ONE)).toEqual([]);
    expect(canvasSuggestions({ intent: 'task', about: null })).toEqual([]);
  });
});

describe('canvasPlaceholder', () => {
  it('is the top suggestion; a starter trails off', () => {
    expect(canvasPlaceholder(canvasSuggestions(PLAIN, CALM_BUSY))).toBe('What are the 3 agents working on?');
    expect(canvasPlaceholder(canvasSuggestions(PLAIN, CALM))).toBe('Start something new…');
    expect(canvasPlaceholder([])).toBeUndefined();
  });
});

describe('pickedStatus', () => {
  it('says plainly whether anything is blocked', () => {
    expect(pickedStatus(CALM)).toBe('nothing blocked');
    expect(pickedStatus(ONE)).toBe('1 blocked');
    expect(pickedStatus({ ...TWO, needsYouCapped: true })).toBe('2+ blocked');
    expect(pickedStatus(null)).toBeNull();
  });
});

describe('pulseNeedsYou', () => {
  it('names each waiting task by its plain sentence, never the commit-style title', () => {
    expect(pulseNeedsYou([
      { title: 'feat(checkout): add retries to the shipping label webhook' },
      { title: '[builder · after CI #1] fix(billing): round currency per line' },
      { title: 'Round per line, or only the total?' },
    ]).map(n => n.title)).toEqual([
      'Add retries to the shipping label webhook',
      'Round currency per line',
      'Round per line, or only the total?',
    ]);
  });

  it('the needs-you hero and row 1 then read as plain language', () => {
    const pulse = { needsYou: pulseNeedsYou([{ title: 'feat(checkout): add retries to the shipping label webhook' }]), live: 0 };
    const hero = canvasHero({ pulse, name: 'Maya', now: NOW, timeZone: 'UTC' });
    expect(hero.sub).not.toMatch(/feat\(|\):/);
    expect(hero.sub).toContain('Add retries to the shipping label webhook');
    expect(canvasSuggestions({ intent: null, about: null }, pulse)[0].label).not.toMatch(/feat\(|\):/);
  });
});

describe('needsYouAction: row 1 as a short action', () => {
  // Fictional, real-shaped titles. The subject keeps content words only (no
  // articles, prepositions or verbs), prefers the head noun phrase plus a
  // proper noun, and falls back to a generic action rather than read wrong.
  const CASES: Array<[string, Parameters<typeof needsYouAction>[0], string]> = [
    ['the demo question (no stored label)', { title: 'feat(checkout): pay in the presentment currency via Stripe', waitingType: 'question' }, 'Answer the Stripe currency question'],
    ['a classifier label that leads with a function word', { title: 'feat(checkout): pay in the presentment currency via Stripe', label: 'Stripe in presentment currency', waitingType: 'question' }, 'Answer the Stripe currency question'],
    ['a clean stored label', { title: 'x', label: 'Stripe currency', waitingType: 'question' }, 'Answer the Stripe currency question'],
    ['a question title with no noun phrase', { title: 'Round per line, or only the total?', waitingType: 'question' }, 'Answer the waiting question'],
    ['a conventional-commit title', { title: 'feat(billing): add multi-currency support to invoices', waitingType: 'question' }, 'Answer the multi-currency support question'],
    ['failed tests on a commit-style title', { title: 'fix(labels): shipping label webhook fails on busy days', state: 'tests_failed' }, 'Fix the failing shipping label webhook change'],
    ['failed tests on a one-word stored label', { title: 'fix(labels): label retries', label: 'label', state: 'tests_failed' }, 'Fix the failing label change'],
    ['a permission', { title: 'chore(db): drop the old invoices table', waitingType: 'permission' }, 'Approve the old invoices table step'],
    ['a confirmation with a stored label', { title: 'x', label: 'old table', waitingType: 'confirmation' }, 'Confirm the old table change'],
    ['a one-word derived subject falls back', { title: 'Pick a currency' }, 'Answer the waiting question'],
    ['an acronym keeps its case', { title: 'feat(export): add CSV export for invoices', waitingType: 'question' }, 'Answer the CSV export question'],
    ['nothing usable at all', { title: 'feat: ???', state: 'tests_failed' }, 'Fix the failing change'],
  ];
  for (const [name, input, want] of CASES) {
    it(name, () => expect(needsYouAction(input)).toBe(want));
  }

  const FUNCTION = /\b(a|an|the|in|on|of|to|for|via|with|per|or|and|only|by|at|from)\b/i;
  it('never names a function word in the subject, never cuts a word, never uses an ellipsis', () => {
    for (const [, input] of CASES) {
      const a = needsYouAction(input);
      const subject = a.replace(/^(Answer|Approve|Confirm) the |^Fix the failing /, '').replace(/ (question|step|change)$/, '');
      expect(a).not.toContain('…');
      if (subject !== 'waiting' && !/^(question|step|change)$/.test(subject)) expect(subject).not.toMatch(FUNCTION);
      expect(a.length).toBeLessThanOrEqual(48);
    }
  });

  it('pulseNeedsYou carries the action, from the loader state', () => {
    const [n] = pulseNeedsYou([{ title: 'feat(checkout): pay in the presentment currency via Stripe', waitingType: 'question' }]);
    expect(n).toEqual({ title: 'Pay in the presentment currency via Stripe', action: 'Answer the Stripe currency question' });
  });

  it('the sub line keeps the full task name', () => {
    const pulse = { needsYou: pulseNeedsYou([{ title: 'feat(checkout): pay in the presentment currency via Stripe', waitingType: 'question' }]), live: 0 };
    expect(canvasHero({ pulse, name: null, now: NOW, timeZone: 'UTC' }).sub).toContain('Pay in the presentment currency via Stripe');
    expect(canvasSuggestions(PLAIN, pulse)[0].label).toBe('Answer the Stripe currency question');
  });
});
