const dir = process.env.CANDIDATE_DIR!;
const store = await import(`${dir}/src/store.ts`);
const svc = await import(`${dir}/src/service.ts`);
const stats = await import(`${dir}/src/stats.ts`);
const { handle } = await import(`${dir}/src/api.ts`);

const bad: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) bad.push(`${name}: got ${g}, want ${w}`);
};
const ids = () => svc.listNotes().map((n: { id: string }) => n.id);

store.resetStore();
for (const id of ['a', 'b', 'c']) svc.createNote(id, `text ${id}`);
eq('start count', stats.noteCount(), 3);
eq('start latest', stats.latestNoteId(), 'c');

eq('delete b', svc.deleteNote('b'), true);
eq('list after delete', ids(), ['a', 'c']);
eq('get deleted', svc.getNote('b'), null);
eq('count after delete', stats.noteCount(), 2);
eq('delete again', svc.deleteNote('b'), false);
eq('delete unknown', svc.deleteNote('zzz'), false);

eq('restore b early', svc.restoreNote('b'), true);
eq('order after early restore', ids(), ['a', 'b', 'c']);
eq('count after early restore', stats.noteCount(), 3);
eq('delete b again', svc.deleteNote('b'), true);

eq('delete latest', svc.deleteNote('c'), true);
eq('latest after delete', stats.latestNoteId(), 'a');
eq('api list', (handle('GET', '/notes').body as { id: string }[]).map((n) => n.id), ['a']);
eq('api delete deleted', handle('DELETE', '/notes/c').status, 404);
eq('api get deleted', handle('GET', '/notes/c').status, 404);

eq('restore unknown', svc.restoreNote('zzz'), false);
eq('restore live', svc.restoreNote('a'), false);
eq('restore b', svc.restoreNote('b'), true);
eq('order after restore', ids(), ['a', 'b']);
eq('count after restore', stats.noteCount(), 3 - 1);
eq('restore c over api', handle('POST', '/notes/c/restore').status, 200);
eq('order after both', ids(), ['a', 'b', 'c']);
eq('latest after restore', stats.latestNoteId(), 'c');
eq('count after both', stats.noteCount(), 3);
eq('api restore live', handle('POST', '/notes/c/restore').status, 404);
eq('api restore unknown', handle('POST', '/notes/q/restore').status, 404);
eq('text survives', svc.getNote('b')?.text, 'text b');
eq('deletedAt cleared', svc.getNote('b')?.deletedAt, undefined);

store.resetStore();
const x = svc.createNote('x', 'x');
eq('delete x', handle('DELETE', '/notes/x').status, 204);
// The brief asks for deletedAt to be set but names no lookup that must still
// return a deleted note, so `find` may filter deleted notes like every other
// read. Accept the mark wherever the deleted record is reachable: the object
// createNote returned (marked in place), or the store's find (raw lookup, or a
// clone written on delete).
const marked = [x, store.find?.('x')].some((n) => typeof n?.deletedAt === 'number');
eq('marked, not destroyed', marked, true);

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
