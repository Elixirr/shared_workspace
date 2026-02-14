#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository."
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"

msg="${1:-}"
if [ -z "$msg" ]; then
  timestamp="$(date +"%Y-%m-%d %H:%M")"
  msg="chore: update pipeline (${timestamp})"
fi

# Stage everything except generated/local artifacts.
git add -A -- . \
  ':(exclude)public/demo/**' \
  ':(exclude)node_modules/**' \
  ':(exclude)dist/**' \
  ':(exclude).DS_Store' \
  ':(exclude)**/.DS_Store'

if git diff --cached --quiet; then
  echo "No staged changes to commit."
  exit 0
fi

echo "Committing on branch: ${branch}"
git commit -m "$msg"

echo "Pushing to origin/${branch}"
git push origin "$branch"

echo "Done: committed and pushed."
