# invoice

Renders invoice lines and a total as text. Amounts are integer minor units.
`JPY` and `KRW` have no minor unit; every other code is rendered with two
decimals. The change under review is a pure refactor: output must not change.
