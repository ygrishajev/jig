# Installation

[Documentation](README.md) · [Project home](../README.md)

## Requirements

- Node 20.17 or newer for the CLI. Development and CI use the version pinned in `package.json`.
- Git 2.38 or newer, including `git merge-tree --write-tree`.
- A running local Docker daemon.
- Credentials for each configured agent. See [credentials](authentication.md).

Run commands from the target repository's root. Configure your Git identity for automatic
merges. A repository signing setup is needed only when you opt into `commitSigning: "repo"`.

## From npm

Install `@ygrishajev/jig` from the public npm registry. No registry mapping or npm
credentials are needed to install it.

### Global installation

```bash
npm install --global @ygrishajev/jig
jig --help
```

Run `jig init` and `jig run ../request.md` from the target repository's root.

### Development dependency

Install in the target repository:

```bash
npm install --save-dev @ygrishajev/jig
npx jig --help
```

Use `npx jig init` and `npx jig run ../request.md` from that repository. npm scripts
can invoke `jig` directly because npm adds local dependency binaries to `PATH`.

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

Continue with the [quickstart](../README.md#quickstart).

## GitHub command setup

The installed `jig` includes `jig github implement --issue <number>`. It requires no
`gh` executable. Provide `GITHUB_TOKEN` or `GH_TOKEN` with issue and pull request
access, and Git credentials able to push branches and hidden run refs to `origin`.
Start from the repository's default branch after committing your jig configuration.
