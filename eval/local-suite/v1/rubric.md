# Independent review rubric, version 1

One fixed reviewer (the same model, prompt and rubric for every run) reads the
problem statement and the agent's diff. It never sees the model's name, the
reference fix or the hidden tests. It answers `approved` or `changes_requested`
and the number of rework rounds it would ask for (0 when approved).

Request changes when any of these holds:

1. The change does not address the stated problem, or addresses only part of it.
2. It special-cases the example in the problem instead of the general rule.
3. It edits, skips or deletes an existing test, or weakens an assertion.
4. It changes behaviour outside the problem (unrelated edits, renamed public names).
5. It leaves the code not type-correct or visibly broken to a careful reader.

Do not request changes for style, naming taste or a different but sound design.
Alternative correct fixes are approved.
