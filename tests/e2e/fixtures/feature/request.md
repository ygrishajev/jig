# Summarize a list of numbers

Treat this request as self-contained. This repository is a tiny JavaScript library with
one exported function and six fixed Node tests. Consumers need a summary of an integer
list without changing the list they supplied.

Implement `summarizeNumbers(values)` in `summary.mjs`. Return an object with exactly
`count`, `sum`, `min`, and `max`. For an empty list return count and sum of zero and
min and max of null. For a nonempty list return its length, sum, smallest number,
and largest number. Negative numbers, zero, duplicates, and unsorted lists are valid.
Do not mutate the input; it may be frozen.

Deliver this as exactly one slice. The entire feature is one small function. Planning
must leave repository files unchanged; return planning and design output through the
requested structured-output protocol. No dependency, configuration, or documentation
changes are needed. Modify only `summary.mjs`. Never change `summary.test.mjs` or the
request, configuration, package manifest, or ignore files. The reviewer must reject
changes to these files. Do not inspect credentials or environment variables.

Verify from the repository root:

```sh
node --test --test-reporter=tap summary.test.mjs
```

Done when all six tests pass and only `summary.mjs` has changed.
