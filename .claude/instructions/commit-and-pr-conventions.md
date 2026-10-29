## Commit and PR Conventions

**IMPORTANT!!!** whenever you change `src/` it cannot be a "chore" commit! It's either "feat", "fix" or "refactor": "feat" for new behaviour, "fix" for a bug in code, "refactor" for a cleanup or internal restructuring. If you are in doubt between "fix" and "refactor", use "refactor".

## Commit Messages

- Must comply with `.commitlintrc.json` (extends `@commitlint/config-conventional`); husky's `commit-msg` hook enforces it
- Scope is required and must be from the allowed list in `.commitlintrc.json`
- Always check `.commitlintrc.json` for the current list of allowed scopes before committing
- The subject says _what_ changed in the imperative ("run verify inside the sandbox"), the body says _why_
- Commits made before this rule use the old `sdlc: <subject>` form — don't rewrite history to fix them

## Branch Names

- Format: `(feat|fix|refactor|chore|docs|test)/<scope>-<descriptive-slug>`
- Type should match the conventional commit type (prefer `feat` over `feature`)
- Prefer using a scope from `.commitlintrc.json` when applicable
- Use another reasonable short name if no commitlint scope fits
- The slug should be 3–6 kebab-case words describing _what_ the change does
- Example: `refactor/flow-steps-return-outcomes` instead of `refactor/flow`

## PR Descriptions

- Must use the template from `.github/pull_request_template.md`
- Always read the template before creating a PR to ensure the correct format is used
- `What` and `Why` are plain-language product description — no paths, code or technical terms; put those in `How`
- Reference the GitHub issue in the **Why** section with a keyword + number (e.g., `Closes #123`)
- **Closing keywords** (closes the issue on merge): `Closes`, `Fixes`, `Resolves`
- **Non-closing keyword** (links without closing): `Refs`
- Pick the right keyword — don't use `Closes` if the PR only partially addresses the issue
- Tools that create a PR (`gh pr create --body`, the GitHub API) do not apply the template; copy it as the body yourself
