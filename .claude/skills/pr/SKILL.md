---
name: pr
description: Raise a pull request for the current ListPal backend work and leave it open, with a description written for later auditing. Invoke straight away whenever the user's whole message is "PR" (any case, with or without punctuation), and whenever they ask to raise, open or create a PR without merging it. Typing "PR" is the go-ahead, so do not ask for confirmation. Not for reviewing or asking about an existing PR, such as "review PR 22", or for raising a PR and merging it, which the merge skill handles.
---

# Raise a backend PR

The user types "PR" when the work is ready for a pull request. That one word authorises committing, pushing and opening the PR. It stops there: don't merge, and don't run `terraform apply`.

The `merge` skill follows these same steps before it merges.

## Steps

### 1. Work out what goes in the PR

```sh
git status --short
git branch --show-current
git log --oneline origin/main..HEAD
gh pr view --json number,state,baseRefName,url
```

- **Open PR on this branch:** use it. Commit any further work for it, and update the description with `gh pr edit` so it covers the whole branch.
- **Nothing uncommitted and no commits ahead of main:** say there is nothing to raise and stop.

The user may be editing other files at the same time, so only include files that belong to this work. If some changes clearly belong to something else, leave them uncommitted and say so. Ask only if you can't tell what the work is.

### 2. Check the work

```sh
cd test && yarn install && yarn test
```

Run `terraform -chdir=terraform validate` too if `terraform/` changed and it's already initialised. A plan isn't needed to raise a PR. A failure doesn't stop the PR, as an open PR is a fair place for unfinished work. Put the failure in the Testing section and tell the user about it.

Check that `ARCHITECTURE.md` reflects the branch and update it if not, as `CLAUDE.md` requires. A new route needs both a `lambda_routes` entry in `terraform/locals.tf` and a `case` in `src/handler.js`.

### 3. Commit and push

If on `main`, branch first, using the repo's prefixes: `feature/`, `fix/`, `perf/` or `chore/`, followed by a short description. Stage files by name, never with `git add -A` or `git add .`, then read `git diff --cached --stat` to confirm the list is right. Nothing from `test-data/exports` can be committed, as it holds real email addresses, and no secrets or personal data either.

Follow the repo's commit style: a short imperative subject and a brief why. Push with `git push -u origin <branch>`.

### 4. Raise the PR

Use `gh pr create --base main` with the description format below, as its own tool call.

### 5. Report

Give the PR link, the check results, and anything left uncommitted. Mention that the checkout is still on the PR's branch, and that typing "Merge" will merge it.

## PR description

The reader is someone looking back months later to see what was added and why, with no memory of this conversation. Aim for 100–250 words: enough to understand and audit the change without opening the diff, without narrating every file. Very small changes can be shorter, but keep every section.

Title: plain and imperative, naming the feature or fix rather than the files ("Retire the board routes replaced by /sync").

```markdown
**Type:** feature | fix | improvement | refactor | docs | chore

## Why
The problem or goal, including which client or job needed it.

## What changed
3–6 bullets describing behaviour, grouped by what it does rather than by file. Name routes, tables and Lambda handlers where they changed. Call out any API contract or data change, and any decision a reader might otherwise question.

## Testing
What was actually run and the result, and what was not tested, such as behaviour only checked with mocks rather than the real Dev tables.

## Deploy and follow-ups
Whether it needs `terraform apply`, any order it depends on with a frontend PR (link it), and any known gaps.
```

End with the attribution lines the session specifies, if any. Keep to observed facts: don't claim a test ran unless it did. Leave out session details such as "as discussed", and anything personal or secret.

The `Type` line and consistent headings make the history searchable:

```sh
gh pr list --state merged --limit 200 --search '"Type: feature" in:body' --json number,title,mergedAt
```
