---
name: merge
description: Raise a pull request for the current ListPal backend work and merge it into main, with a PR description written for later auditing. Invoke straight away whenever the user's whole message is "Merge" or "Force merge" (any case, with or without punctuation), and whenever they ask to raise, open or create a PR and merge it. Typing "Merge" is the go-ahead, so do not ask for confirmation. Not for combining code or files, merging main into a branch, or opening a PR that should stay open, which the pr skill handles.
---

# Raise and merge a backend PR

The user types "Merge" when the work is finished. That one word authorises committing, pushing, opening the PR and merging it. Merging does not release anything: production only changes through `terraform apply`, which stays a separate decision the user makes each time.

## Steps

### 1. Raise the PR

Read `.claude/skills/pr/SKILL.md` and follow it, including its description format, but leave out its report. If the branch already has an open PR it updates that one, and if the PR is already up to date there is nothing to change, so go on to the next step.

If there is nothing to merge at all, say so and stop.

### 2. Stop if the local checks failed

A failed check doesn't stop a PR, but it does stop a merge. If a check failed because of this work, leave the PR open and report the failure. "Force merge" carries on regardless and records the failure in the force merge comment.

### 3. Merge

Before merging a PR that has another PR based on its branch, retarget the upper PR to `main` with `gh pr edit <upper> --base main`. Otherwise deleting the branch closes the upper PR for good.

Run the merge as its own tool call, because it can need separate approval:

```sh
gh pr merge <number> --merge --delete-branch
```

This repo uses merge commits. If that doesn't merge, check `gh pr view <number> --json mergeStateStatus,statusCheckRollup,reviewDecision` and act on the status:

| Status | What to do |
| --- | --- |
| `BLOCKED` by a required review or branch rule | Force merge |
| `UNSTABLE`, or a required check has failed | "Merge": stop and report the failure, as it's news the user hasn't seen. "Force merge": force merge |
| Checks still running | Wait with `gh pr checks <number> --watch`, then try again |
| `BEHIND` | Run `gh pr update-branch <number>`, then try again |
| `DIRTY` (conflicts) | Forcing can't fix this. Merge `origin/main` into the branch. Resolve the conflicts if the right result is clear, rerun the checks and push. Otherwise stop and report them |

### Force merging

A force merge is `gh pr merge <number> --merge --delete-branch --admin`, which skips required reviews and checks. It has one purpose, getting this PR past GitHub's merge requirements, so these stay off limits:

- force pushing `main`
- pushing directly to `main`
- changing branch protection
- calling the API to get around a refusal

Straight after a force merge, record it so the audit trail shows it:

```sh
gh pr comment <number> --body "Force merged: <what was bypassed and why>."
```

If a tool call for the merge is denied, stop and tell the user. A denial is a decision, so don't try another route.

### 4. Confirm

```sh
gh pr view <number> --json state,mergedAt,mergeCommit
git status --short
git branch --show-current
```

Only report success if the state is `MERGED`. `gh` normally leaves the checkout on an up-to-date `main`. If it doesn't, say so, and don't discard or stash the user's edits to fix it.

Report the PR link, the merge commit, anything left uncommitted, whether it was forced, and whether the change still needs a `terraform apply`. Don't run the apply.
