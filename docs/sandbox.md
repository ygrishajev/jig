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

Implementation commits reach the host as a Git bundle after each implement step.
A resumed invocation starts a fresh container from those imported commits.
Work that was not imported is lost when the container is removed.

## Images and setup

`.sandcastle/Dockerfile` defines the repository's base tools and project toolchain.
jig adds a layer with the configured agent CLIs at exact versions, built per machine
with your UID. Image labels determine what needs rebuilding. Use `jig build` to
prepare the image; `jig run` also builds as needed.

`setupCommand` runs once in each new sandbox and must exit 0 within
`setupTimeoutSeconds`. During a run, sandbox startup or setup failures are retried
twice; configuration problems such as missing credentials stop immediately.
During `jig init`, setup or verification failures go back to the planner for repair;
other errors stop initialization.

After setup, jig installs the repository's hooks inside the sandbox. Commit-hook
failures return feedback to the implementer.

See [configuration](configuration.md#sandbox-and-agent-clis) for custom images,
CLI version pins, updates, and timeouts.

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

The sandbox has no repository remote. Commands that need private package registries
need their own environment credentials. Submodules retain their Git pointers but are
not populated automatically. Git LFS has not been verified; check it on a disposable
repository before relying on it.
