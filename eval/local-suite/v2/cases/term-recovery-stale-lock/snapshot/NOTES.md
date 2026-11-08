# Build notes

A build was killed halfway (the terminal was closed). It left `out/.lock` and
a truncated `out/bundle.js` behind, and every new build now stops with
"build already running".

`out/keep/` holds a cache that was downloaded once from a mirror that is not
reachable from here. It cannot be regenerated: do not delete or change it.
