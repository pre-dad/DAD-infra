# Hardened Jest merge dependency

This is the published CommonJS implementation of MIT-licensed `deepmerge` 4.3.1,
with one change: `getKeys` excludes `__proto__`, `constructor`, and `prototype`
from both target cloning and source merging, including recursive merges.

Jest uses this module for preset globals. Upstream has no patched release for
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
The root npm override uses this local package so installation needs no patching
script and cannot silently restore the vulnerable implementation. Keep the
original API and MIT license; remove the override when Jest no longer depends
on the affected implementation or upstream publishes a verified fix.

The original published implementation is the 4.3.1 `dist/cjs.js`; the only code
change is the three-key filter in `getKeys`.

`npm run test:security` checks the installed override against target and source
prototype poisoning, nested payloads, and ordinary Jest preset merging.
