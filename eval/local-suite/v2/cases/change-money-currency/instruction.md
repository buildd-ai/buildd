Add euro support to the billing output. `invoiceLine`, `receiptLine` and
`reportRow` each take an optional last argument `currency`, either `'USD'`
(the default) or `'EUR'`, and `summary(items, currency?)` passes it to all
three.

For EUR, only the currency marker changes: invoice uses `€` where it used
`$`; receipt prints `EUR ` where it printed `USD `; report uses `€` where it
used `$`. Digits, rounding, grouping, padding and the way negative amounts
are written stay exactly as each of the three does today. Output for USD,
and for calls that pass no currency, must not change at all, for any amount.
Any other currency value throws a `RangeError`.

`bun test` runs the visible tests. Do not edit them to make them pass.
