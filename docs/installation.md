# Installation

[Documentation](README.md) · [Project home](../README.md)

## Requirements

- Node 20.17 or newer for the CLI. Development and CI use the version pinned in `package.json`.
- Git 2.38 or newer, including `git merge-tree --write-tree`.
- A running local Docker daemon.
- Credentials for each configured agent. See [credentials](authentication.md).

Run commands from the target repository's root. Configure your Git identity for automatic
merges. A repository signing setup is needed only when you opt into `commitSigning: "repo"`.

## From source

```bash
git clone https://github.com/ygrishajev/jig.git
cd jig
npm ci
npm run install:local
jig --help
```

`install:local` builds, packs, and installs the package globally. You can also build with
`npm run build` and invoke `node /path/to/jig/dist/cli/main.js` from the target repository.
Contributor setup, including Git hooks, is in [Contributing](../CONTRIBUTING.md).

## From GitHub Packages

Releases publish as `@ygrishajev/jig` to `npm.pkg.github.com`, not npmjs.org. Access depends
on the package's visibility and your account permissions.

Add this registry mapping to the consuming repository's `.npmrc`:

```ini
@ygrishajev:registry=https://npm.pkg.github.com
```

Authenticate npm to that registry with an account that can read the package, then install:

```bash
npm install --save-dev @ygrishajev/jig
npx jig --help
```

Follow [GitHub's npm registry authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)
for token and CI setup. Keep tokens out of tracked `.npmrc` files.

Continue with the [quickstart](../README.md#quickstart).
