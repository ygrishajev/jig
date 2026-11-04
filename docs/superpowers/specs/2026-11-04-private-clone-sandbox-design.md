# Private Clone Sandbox

Date: 2026-11-04

## Problem

jig's rule is that agents run unattended only inside the sandbox. Two facts undermine it:

- Sandcastle's Docker provider mounts the run's worktree and the repository's whole `.git`
  writable (`resolveGitMounts`), so anything in the sandbox can change the repository's hooks and
  config, and the worktree's `.git` pointer file.
- jig then runs git on the host against that same state: `commitAll`, `headCommit`, `forkPoint`
  and `summariseCommitsSince` in `src/adapters/git/git-workspace.ts`, all from the worktree.

Git hooks and several config keys run programs, so code planted in the sandbox could run on the
operator's machine. This is an open lead from the security audit
(`src/adapters/sandcastle/sandcastle-session.ts:shared-git-metadata-to-host-git-execution`). It has
not been reproduced. The design closes it either way, because the source shows no control that
would stop it and the mount is documented behaviour.

Two smaller problems share the cause:

- Agents can read tokens from `.git/config`.
- A commit made after review reaches the base branch, because the final merge takes the branch tip
  (`src/steps/finishing.ts:mutable-run-head-after-approval`).

Commit signing also needs a decision: with `commitSigning: "repo"`, the default, a repository that
signs commits signs agent code with the operator's key, vouching for code nobody has read.

## Intent

The sandbox can do anything to its own repository and nothing to the operator's. Commits cross the
boundary as data, in one direction, through one narrow function.

- **The host never runs git on a directory or git metadata the sandbox can write.**
- **Commits keep their SHAs** between sandbox and host, so review ranges and saved run state hold.
- **Agent commits are not signed by the operator's key** unless the operator asks.

## Decisions

### The container gets a private clone

A jig-owned provider, built with sandcastle's `createBindMountSandboxProvider`, replaces `docker()`.
Its `create` ignores the worktree and `.git` mounts sandcastle offers. It starts a container, then
clones a bundle of the run branch and the base branch into `/home/agent/workspace`. Only the Codex
login directory is still mounted, and only when configured.

Sandcastle still creates its worktree on the host, and its own host-side git runs there: `rev-parse`
during a run, `status` and `worktree remove` on close. That is safe now, because the sandbox can no
longer reach that worktree.

### Why not the alternatives

| Option                                                | Rejected because                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only mounts over `.git/config` and `.git/hooks`  | The worktree's `.git` pointer file stays writable, so host git could be pointed elsewhere.                                                                                                         |
| `docker()` pointed at a private clone on the host     | Sandcastle's own `git status` on close and commit collection during a run would still run host git in a directory the sandbox wrote to.                                                            |
| Sandcastle's isolated providers (`syncIn`, `syncOut`) | `syncOut` puts names the sandbox reports into host shell commands, joins reported paths onto host paths with no confinement, and rewrites SHAs through `git am`. It assumes a cooperative sandbox. |
| jig's own git flow without sandcastle                 | Sandcastle's agent running, streaming and idle timeouts are worth keeping. Only the sync is replaced.                                                                                              |

### Commits leave as a bundle

One function, `importCommits`, moves commits to the host. It treats everything from the sandbox as
untrusted data:

1. Reads the sandbox's head and accepts it only if it is a full hex SHA.
2. Has the sandbox bundle the run branch, excluding the last approved commit.
3. Copies the bundle's bytes with `docker exec cat` into a new file in a private host directory, up
   to a size limit. Using `docker cp` could bring a symlink across; streaming bytes cannot.
4. Runs `git fetch` with `fetch.fsckObjects=true` from that file, in the host worktree.
5. Refuses unless `FETCH_HEAD` matches the reported head and descends from the last approved commit.
6. Runs `git reset --hard FETCH_HEAD` in the host worktree, with hooks off.

Only approved commits are immutable. An agent may amend its own unapproved work, for example when a
reviewer sends it back, and the next import replaces it. Rewriting an approved commit fails step 5,
which leaves the host branch alone. The step then returns a `JigError`, and the sandbox can be reset
to the last approved commit.

### Only the implement step imports

Commits reach the host only after an implement step. `implementSlice` commits any leftover work
inside the sandbox, with `session.exec`, then imports.

This closes the commit-after-approval lead by construction: a commit made during review or
description is never imported, so it cannot reach the base branch. A stray commit made during
review of slice N would be carried in by slice N+1's import, inside the range reviewed for slice
N+1. As a second check, `mergeRunBranch` refuses unless the branch tip is the last approved commit.

### Git moves behind the session or to the repository root

| `Workspace` method      | Now runs                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `commitAll`             | Inside the sandbox                                           |
| `headCommit`            | On the host, reading the run branch from the repository root |
| `forkPoint`             | On the host, from the repository root                        |
| `summariseCommitsSince` | On the host, from the repository root, after the import      |

`GitWorkspace` loses `worktreePath`, except to run the import.

### Signing and identity

- **Agent commits are unsigned.** The sandbox holds no key. This needs no special handling.
- **Agent commits are authored by a fixed `jig` identity**, set as `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*` in the container. These override the host `user.name` that sandcastle copies into
  the container's global config. The role goes in a trailer on commits jig creates. A compromised
  sandbox can write any author, so this is a label, not proof.
- **jig's automatic merge commit is unsigned**: `commit.gpgsign=false` joins hooks off for that
  merge. Nobody has reviewed that code, and the operator's key should not say otherwise.
- **`commitSigning` defaults to `"skip"`.** With `"repo"`, jig re-signs the whole run branch with the
  operator's setup, once, at the merge step. Signing only at the end means SHAs stay stable for the
  whole run. This is a breaking change to the default and gets a README note.

### What goes into the container

The bundle holds the run branch and the base branch only, where `.git` used to expose every branch.
The operator's `.git/info/exclude` and `core.excludesFile` patterns are copied into the clone's
`.git/info/exclude`; without them `git add -A` in the sandbox would commit files the host ignores.
No remote URL or credentials come with it. Agents cannot push, which they had no reason to do.
Credentials still arrive as env vars.

## Evidence

Two checks ran on 2026-11-04 with sandcastle 0.12.0, a scripted agent and no network. All pass.

`spike/check-private-clone.ts` (19 checks) covers the core flow:

- the container has no mounts, and the host repository path does not exist inside it;
- `sandbox.run` works with the provider, and host commits stay invisible until imported;
- imports keep SHAs, a second import carries only new commits, and host SHAs resolve in the sandbox;
- commits are authored by `jig` and unsigned, even with `commit.gpgsign=true` on the host;
- `.git/config` and the `.git/hooks` listing are unchanged, the run merges, and nothing is left over.

`spike/check-private-clone-edges.ts` (29 checks) covers the edges:

- idle timeouts, failing agents, live streaming and a 300 KB prompt over stdin;
- amending unapproved work imports; rewriting an approved commit is refused and changes nothing;
- a resumed run starts from the last imported commit, and unimported work is gone;
- file modes and symbolic links survive, and a 20 MB commit imports in about a second;
- the Codex login directory mounts and refreshes, and local excludes reach the clone;
- a submodule stays an empty directory with its pointer intact, as in a new worktree today.

Bundling this repository's `main` took 0.6 seconds and 883 KB.

The first run of the edge checks found the lost excludes and showed that refusing every rewrite was
too strict. Both are fixed above.

They do not cover:

- real agents: claude, opencode and codex have not run through this provider;
- `init`'s throwaway sandbox, or a real image built by `jig build`;
- Git LFS, because `git-lfs` is on neither this machine nor the test image;
- a sandbox actively trying to break out. The audit's blocked candidate is still unverified, so
  this design rests on removing the shared state rather than on a test of the attack.

## Rollout

Each step lands green.

1. **Provider and import, in one PR.** The provider, `importCommits`, `Workspace` moved as above, and
   fake session support for commits made inside the sandbox. They land together because either one
   alone breaks runs. Finish with a live E2E run using real agents.
2. **Merge.** The tip-equals-approved check and an unsigned merge commit.
3. **Signing.** The `commitSigning` default, re-signing at the merge step, and the README's "What the
   sandbox sees" and install requirements.

## Non-goals

- Network isolation for agents, which need their providers.
- Stopping a compromised agent from lying to the reviewer. The sandbox can still fool an agent
  reviewer; `mergeMode: "manual"` remains the answer to that.
- Reproducing the audit's blocked candidate.

## Anti-goals

- Don't add `syncOut` or `git am` back for convenience. Both trust what the sandbox reports.
- Don't mount anything from the repository "just for speed". One writable mount of git state undoes
  this design.
- Don't parse sandbox output into a host command or path without validating it first.

## Left to the builder

- **Dependence on sandcastle internals.** The provider relies on two behaviours: `syncOut` runs only
  for isolated providers, and a bind-mount provider may ignore its mounts. Keep the spike as the
  check to re-run when upgrading sandcastle.
- **Git LFS.** Check it before calling the feature done, then either populate objects in
  `setupCommand` or document the gap. Submodules behave as they do in a new worktree today.
- **The default global ignore file.** The spike reads `core.excludesFile` only, so it misses git's
  default of `~/.config/git/ignore` when that key is unset.
- **Large repositories.** The clone carries the full history of both branches, because review ranges
  need the fork point. Measure a large repository before optimising.
- **Crash recovery.** Commits not yet imported die with the container, which at worst repeats one
  implement step. A resumed run clones from the host's run branch.
- **Image compatibility.** Carry over `HOME`, the SELinux label and shutdown cleanup from `docker()`.
  With no repository mounts, file ownership should only matter for the Codex login, so the UID check
  may be able to shrink to that case. The spike ran as an image whose UID matches this host, so
  check this on a different UID.
