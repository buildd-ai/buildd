import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../ChatActions', () => ({ useChatActions: () => ({ answerQuestion: async () => {} }) }));
mock.module('./ObjectStoreProvider', () => ({ useObjectStore: () => ({ set: () => {}, refresh: () => {} }) }));
mock.module('@/app/app/(protected)/tasks/[id]/respond/use-answer-submit', () => ({
  useAnswerSubmit: () => ({ submit: () => {}, sending: null, outcome: null, error: null }),
}));
const { QuestionCard } = await import('./QuestionObject');

describe('past question chat card', () => {
  it.each([null, 'Use the existing path'])('collapses a closed ask with answer %s', answer => {
    const html = renderToStaticMarkup(<QuestionCard objRef={{ kind: 'question', id: 't' } as any}
      view={{ open: false, answer, taskId: 't', workerId: 'w', askerLabel: 'The builder asks',
        question: { headline: 'Which approach?', options: [], noteId: null, body: null },
      } as any} />);
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain(answer ?? 'Not answered');
    expect(html).not.toContain('<textarea');
  });
});
