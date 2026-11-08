# Requirements notes

The requirements for this project are spread over a long body of notes: some
are superseded, some are not about your question, and the notes do not say
which is which except through the text itself.

`evidence/needles.json` holds the numbered requirements that matter for some
question. `evidence/filler.md` holds the remaining notes, one entry per
paragraph. When the harness runs a track it also places the combined text at
`evidence/context-<size>.md` (8K, 16K or 32K tokens of the same material, the
numbered requirements at a recorded position) or puts the same text in the
prompt. The text is the only evidence there is.
