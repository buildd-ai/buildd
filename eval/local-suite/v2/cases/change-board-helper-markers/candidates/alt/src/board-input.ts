import { pickContext, type BoardTaskInput, type RawTask } from './types';

export function toBoardTaskInput(t: RawTask): BoardTaskInput {
  return { id: t.id, title: t.title, status: t.status, context: pickContext(t) };
}
