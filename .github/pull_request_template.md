## What

<!-- The result, in plain words: what someone running jig can do or see now. No code, paths or technical terms. -->

## Why

<!-- The motivation, in plain words. Reference the issue with a keyword: `Closes #123` if this fully resolves it, `Refs #123` if it only partly does. -->

## How

<!-- For reviewers: a short before/after flow in pseudocode when behaviour changed. Explain what differs, when it matters, and why. -->

<!-- When this changes where something lives (a module owner, schema, default, failure class, port or wiring): name the owner, why the concept belongs there, and whether it is a pattern agents should copy or a one-off. -->

<!-- Read .claude/skills/pr-dependency-diagram/SKILL.md and follow it to include a diagram when internal TypeScript imports change. -->

## Verification

<!-- The commands you ran and what they reported. Say what you could not run. -->

- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `npm run build`
- [ ] `npm run lint`
- [ ] `npm run format:check`

## Deletions and deviations

<!-- Dead code removed instead of tested, requirements not met or changed. Write "None" if none. -->

## Sandbox safety

- [ ] No agent call runs on the host, and no credential is written to a file, a log line or the image
