In this repository, when a request to the server fails with a temporary
error, something makes the client wait longer after each failed attempt, up
to a ceiling, before it tries again.

Find the code that does this. More than one place may look like it does:
name every place that plausibly implements it, and say which one actually
runs when the client makes a request.

Write your answer to `answer.json` in the repository root:

    {"citations": [{"file": "path/from/repo/root", "symbol": "name"}],
     "liveSite": "path/from/repo/root"}

If nothing in the repository implements the behaviour, write
`{"abstain": true, "citations": []}` instead. Do not change any other file.
