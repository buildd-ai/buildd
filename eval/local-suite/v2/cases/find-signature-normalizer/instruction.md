Somewhere in `packages/core` there is code that takes the free text of a
failure's error message and blanks out the parts that differ between
occurrences (identifiers, timestamps, file paths, numbers), so that repeats
of the same failure compare equal.

Name the function that does the blanking itself. Code that only calls it, or
that builds a key from its output, is not the answer.

Write your answer to `answer.json` in the repository root:

    {"citations": [{"file": "path/from/repo/root", "symbol": "name"}]}

If nothing implements the behaviour, write
`{"abstain": true, "citations": []}` instead. Do not change any other file.
