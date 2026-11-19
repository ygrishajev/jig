---
name: pr-dependency-diagram
description: Include changed internal TypeScript imports when drafting a pull request description for the jig repository.
---

When writing this repository's PR description, generate a diagram of the internal imports added or removed by the branch. The generator compares committed snapshots and includes only changed edges between files under `src/`.

Use the PR's actual target branch or supplied base commit. For the usual target, `main`, run from the repository root:

```sh
base=$(git merge-base main HEAD)
node --import tsx scripts/dependency-diff.ts "$base" HEAD --pr
```

Paste the generated legend and Mermaid block under **How**. Empty output means there are no changed imports, so omit the diagram. If the base cannot be determined or the generator fails, state briefly under **How** that the diagram could not be generated. Use the installed project dependencies and the sandbox's Node version.

To render a standalone SVG locally with Graphviz installed, pass an output path in place of `--pr`.
