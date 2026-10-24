#!/usr/bin/env bash
# Updates ARCHITECTURE.md from the staged diff using a cheap model.
# Called by .githooks/pre-commit. Never blocks a commit: failures only warn.

set -u

ROOT="$(git rev-parse --show-toplevel)"
DOC="ARCHITECTURE.md"
MODEL="${ARCH_DOC_MODEL:-haiku}"

cd "$ROOT" || exit 0

# Nothing to do if the only staged change is the document itself.
CHANGED="$(git diff --cached --name-only | grep -v "^${DOC}$" || true)"
if [ -z "$CHANGED" ]; then
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "update-architecture: claude CLI not found, skipping ${DOC} update" >&2
  exit 0
fi

# Exclude lockfiles and archives, which add cost and no useful signal.
DIFF="$(git diff --cached -- . ':(exclude)*.lock' ':(exclude)src.zip' ':(exclude)test-data/exports')"

PROMPT="You maintain ${DOC} for this repository. Below is the staged diff for the commit about to be made.

Edit ${DOC} in place so that it accurately reflects the repository after this diff. Rules:
- Change only the parts the diff affects. Keep the structure, tables and Mermaid diagrams valid.
- Any diagram must be Mermaid in a fenced mermaid block. Add or amend diagrams where they aid understanding of the change.
- Write British English. Do not use em dashes or en dashes. Avoid florid or AI-sounding prose.
- Do not record commit hashes or a change history. Remove statements that are no longer true.
- If the diff fixes something listed under security and quality observations, remove or amend that item.
- If the diff does not affect the architecture, leave the file unchanged.
- Do not touch any other file.

Staged diff:
${DIFF}"

if ! printf '%s' "$PROMPT" | claude -p \
  --model "$MODEL" \
  --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" \
  >/dev/null 2>&1; then
  echo "update-architecture: model call failed, ${DOC} not updated" >&2
  exit 0
fi

git add "$DOC"
echo "update-architecture: ${DOC} checked with ${MODEL}"
