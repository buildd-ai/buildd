Review the change in `change.diff`. The files in the repository are the
tree after the change is applied; `README.md` describes the intended behaviour.

Report defects the change introduces: wrong behaviour, not style. Report each
once, at the line where it lives, with the cause in a sentence. Do not report
anything that is correct, and do not report problems that were already there
before the change. A review that finds nothing is a valid answer when
nothing is wrong.

Write your review to `review.json` in the repository root:

    {"findings": [{"file": "path/from/repo/root", "line": 12, "description": "what is wrong and why"}]}

Use `{"findings": []}` if you find no defect. Do not change any other file.
