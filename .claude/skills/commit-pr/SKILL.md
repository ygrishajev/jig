---
name: commit-pr
description: jig's conventions for committing, naming a branch and opening a pull request. Use whenever you are about to run git commit, create a branch, or open a PR with gh in this repo, or the user asks to commit, push, branch or "open a PR".
---

# Commit, branch, PR

## Commit

1. Check `node --version` against `package.json`'s `engines` and `volta` entries before committing.
   The `commit-msg` hook runs `npx commitlint`; an older shell runtime can fail before commitlint
   checks the message. If the shell picked the wrong runtime, run `git commit` with the project's
   installed Node version first on `PATH`. Do not bypass the hook.
2. Read `.commitlintrc.json` for the allowed scopes — the list changes; don't work from memory.
   husky's `commit-msg` hook enforces `@commitlint/config-conventional` plus a required scope.
   Keep each body line at most 100 characters, as required by the inherited commitlint rules.
3. Pick the type from what the commit touches:
   - **Anything under `src/` is never `chore`.** `feat` for new behaviour, `fix` for a bug in
     code, `refactor` for a cleanup or internal restructuring. Torn between `fix` and `refactor`:
     `refactor`.
   - `chore`, `docs`, `test`, `ci` only when `src/` is untouched — check with
     `git diff --cached --name-only | grep '^src/'`.
4. Subject: _what_ changed, imperative ("run verify inside the sandbox"). Body: _why_.
5. Commits before this rule use `sdlc: <subject>` — don't rewrite history to fix them.

## Branch

- `(feat|fix|refactor|chore|docs|test)/<scope>-<descriptive-slug>`; the type matches the commit
  type (`feat`, not `feature`).
- Scope from `.commitlintrc.json` when one fits, otherwise another short name.
- Slug: 3–6 kebab-case words saying _what_ the change does — `refactor/flow-steps-return-outcomes`,
  not `refactor/flow`.

## Pull request

1. Read `.github/pull_request_template.md` and fill in every section. `gh pr create --body` and
   the API don't apply the template — copy it into the body yourself.
2. **What** and **Why** are plain-language product description — no paths, code or technical
   terms. Those go in **How**.
3. Reference the issue in **Why**: `Closes` / `Fixes` / `Resolves #123` when the PR fully
   resolves it, `Refs #123` when it only partly does.
4. When the change decides where something lives — a module owner, a schema, a default, a failure
   class, a port, wiring — **How** names the owner, says why the concept belongs there, and says
   whether it sets a pattern agents should copy or is a one-off they should not. Dependency lint
   checks import directions; reviewers judge ownership from what you write here. Name the owner in
   the target layout of `docs/specs/application-boundaries.md`, and say so when today's layout
   keeps the code elsewhere.
5. **Verification** lists the commands actually run and what they reported, and says what was not
   run. Don't tick a box you didn't run.
