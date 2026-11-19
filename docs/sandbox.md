# Sandbox and repository boundaries

[Documentation](README.md) · [Project home](../README.md)

Every agent call, setup command, and verification command runs inside a Docker
container. Agents run unattended there. Review the resulting branch before merging;
agent review does not replace your review.

## What the sandbox can access

Each run uses one container with a private clone of `jig/run/<id>` and the base branch.
The clone contains their history, has no remote, and mounts nothing from the host
repository. Other branches and the host's `.git/config` stay outside its reach.
When Codex is configured, only a private copy of its login cache is mounted; see
[authentication](authentication.md).

jig imports implementation commits back to the run branch. When resuming, the new
sandbox starts from the saved commits.

## Images and setup

Use `.sandcastle/Dockerfile` to define the repository toolchain, or set `sandboxImage`
to use an existing image. Use `jig build` to prepare the image in advance. `jig run`
also builds as needed.

`setupCommand` runs in each new sandbox and must exit 0 within `setupTimeoutSeconds`.
Repository Git hooks run inside the sandbox when agents commit. See
[sandbox configuration](configuration.md#sandbox-and-agent-clis).

## Merging and signing

The default `mergeMode: "manual"` leaves the run branch for you to inspect and merge.
`mergeMode: "auto"` merges without a human checkpoint and requires a clean operator
working tree. jig disables Git hooks for its own merge, so `post-merge` hooks do not run.

Agent commits are unsigned by default (`commitSigning: "skip"`). With
`commitSigning: "repo"`, jig re-signs the run branch during an automatic merge using
the operator's signing setup, which must work without prompts. Manual merges are
not re-signed by jig. Automatic merge commits are unsigned with `skip`; `repo`
also enables signing for the merge.

## Repository support

Commands that use private package registries need credentials available inside the
container. Populate submodules explicitly if your setup requires them.
