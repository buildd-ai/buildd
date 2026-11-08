Make deleting a note reversible. `DELETE /notes/:id` must no longer destroy
the note: it marks it deleted (set `deletedAt`), and:

- a deleted note disappears everywhere the app reads notes: `GET /notes`,
  `GET /notes/:id` (404), `listNotes`, `getNote`, and the numbers in
  `src/stats.ts`;
- deleting a note that is already deleted, or that never existed, is a 404 /
  `false`;
- new `restoreNote(id)` in the service and `POST /notes/:id/restore` in the
  API bring a deleted note back (200 / `true`), in its original position in
  the list; restoring anything that is not currently deleted is a 404 /
  `false`;
- everything else keeps behaving as it does today.

`bun test` runs the visible tests. Do not edit them to make them pass.
