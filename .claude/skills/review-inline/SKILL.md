---
name: review-inline
description: Review jig's code against its house rules and leave a numbered TODO(review-N) marker in the code at each verified finding, then explain and fix the markers one at a time. Use when the user runs /review-inline, asks for an inline review, or asks to "mark the issues in the code". Takes an optional target — a path, a directory, a branch or "src"; defaults to what the current branch changed against main.
---

# Inline review

A review whose findings live in the code, not in the conversation: each one is a numbered marker
at the line it is about, so it can be found with one grep, explained on its own, fixed on its own
and removed with its fix.

## 1. Pick the target

- No argument: what the current branch changed — `git diff main...HEAD --name-only` plus the
  working tree.
- A path or directory: those files. `src`: the whole codebase.
- Say which files are in scope before reviewing.

## 2. Load the rules

Read `CLAUDE.md` and every file in `.claude/rules/` now; do not work from memory, they
change. Each one is a checklist: `callee-owns-its-rules.md` and `parse-input-at-the-edge.md` for
design, `clean-code-over-comments.md` for naming and comments, the testing rules for specs.

## 3. Sweep

Read each file in scope against every rule. Use these to find candidates fast, then read the code:

- Exports with at most one consumer outside specs — the call site may be doing the callee's work:
  ```bash
  for f in $(find src -name '*.ts' ! -name '*.spec.ts'); do
    for sym in $(grep -oE '^export (async )?(function|const|class|type|interface) [A-Za-z0-9_]+' "$f" | awk '{print $NF}'); do
      users=$(grep -rlw "$sym" src --include='*.ts' | grep -v "^$f$" | grep -v '\.spec\.ts$')
      [ "$(echo -n "$users" | grep -c .)" -le 1 ] && echo "$f $sym -> $(echo $users)"
    done
  done
  ```
- The same expression in two modules: `grep -rn "<expression>" src`.
- Inline comments, `as unknown as`, `beforeEach`, `vi.mock`, raw strings passed below the CLI.

## 4. Verify every finding

Keep a finding only with a concrete failure scenario: what a reasonable next change would silently
break. "A new document would be written but `jig status` would never show it" survives; "this
could be cleaner" does not. Read every call site first. Check what a fix would change besides
structure — retries, error formats, files written — and say so: moving `init`'s sandbox onto
the run's sandbox scope would have retried a failed setup command the planner needs back at once.

## 5. Report, then mark

Report the findings ranked by what they risk, numbered, each with `file:line`, the issue, the
failure scenario and the fix. Then put a marker at each line:

```typescript
// TODO(review-N): <what the caller knows or repeats>; <the fix, in a few words>.
```

Numbers continue from the highest `TODO(review-` already in `src`, so a number is never reused.
Markers are the one exception to the no-inline-comments rule: they are temporary, and each is
removed by its fix. When the user asks to commit, the markers go in a commit of their own:
`refactor(dx): mark …`.

## 6. Explain and fix, one marker at a time

When asked to explain a marker: where it is, the code as it stands, what the caller has to know,
why it matters (the failure scenario), the fix with a sketch, and the alternative you would skip
and why. Then wait.

When asked to fix it:

- Make the change and its spec per `testing-conventions.md`; remove the marker.
- Run, and report the results as they came out:
  `npm run typecheck`, `npx eslint .`, `npx prettier --check .`, `npm run lint:duplication`,
  `npm test`, `npm run test:integration`.
- Commit only when asked: `refactor(<scope>): <what changed>`, the body saying why.

A finding can turn out wrong — a parse that already sits at the edge, a duplication that is two
different rules. Say so, delete its marker, and leave its number unused.
