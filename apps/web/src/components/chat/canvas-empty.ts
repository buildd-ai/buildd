/**
 * The canvas before the first message: a greeting in plain words and a few
 * one-tap questions, so nobody has to know what to type (or that there are
 * shortcuts). Pure.
 */
export interface CanvasSuggestion {
  label: string;
  /** What goes in the box. */
  text: string;
  /** Send right away (a question), or only fill the box (a starter to finish). */
  send: boolean;
}

export function canvasGreeting(name: string | null, about?: { kind: string; title: string | null } | null): string {
  if (about) return about.title ? `Ask anything about ${about.title}.` : `Ask anything about this ${about.kind}.`;
  return name ? `Hi ${name}, what are we working on?` : 'Hi, what are we working on?';
}

export function canvasSuggestions(entry: { intent: 'mission' | 'task' | null; about: 'mission' | 'task' | null }): CanvasSuggestion[] {
  if (entry.about === 'mission') {
    return [
      { label: 'How is it going?', text: 'How is this mission going?', send: true },
      { label: "What's holding it up?", text: "What's holding this mission up?", send: true },
      { label: "What's left?", text: "What's left before this mission is done?", send: true },
    ];
  }
  if (entry.about === 'task') {
    return [
      { label: 'Where is it at?', text: 'Where is this task at?', send: true },
      { label: "What's it doing now?", text: "What's the agent on this task doing right now?", send: true },
    ];
  }
  if (entry.intent) return [];
  return [
    { label: 'What needs me?', text: 'What needs me right now?', send: true },
    { label: "What's running right now?", text: "What's running right now?", send: true },
    { label: 'What shipped this week?', text: 'What shipped this week?', send: true },
    { label: 'Start something new', text: 'I want to build ', send: false },
  ];
}
