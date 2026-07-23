---
name: deploy
description: Deploy this repo — refresh CLAUDE.md and README.md to reflect the current code, commit every change, and push to main (branching-aware). Use when the user says "deploy", "ship it", "publish", or asks to update the docs, commit, and push in one go.
---

# deploy

Ship the current working tree: bring the docs up to date, commit everything, and get it onto `main` on the remote. Follow the steps in order. Do not skip the doc-update steps — they run **before** the commit so the doc changes are part of it.

## 1. Update `CLAUDE.md`

Review what has changed since the last commit and make sure `CLAUDE.md` still describes the repo accurately.

- `git status` and `git diff HEAD` (plus `git log --oneline -10`) to see what's new or changed.
- If indicators were added/removed/renamed, or a cross-cutting pattern or the module contract changed, edit `CLAUDE.md` to match. Keep its existing structure and tone (see the file itself for how it's organized).
- If nothing material changed, leave it as-is — do not churn the file for its own sake.

## 2. Update `README.md`

Same idea for the user-facing README.

- Ensure every indicator in `indicators/` is represented and described correctly, and that install/usage notes are still accurate.
- Add a section for any new indicator, following the format the existing entries use (what it shows, parameters, limitations, install).
- Fix anything now stale. Don't invent content.

## 3. Commit all changes

Stage and commit the entire working tree (including the doc edits above and any untracked files).

```bash
git add -A
git status   # confirm what will be committed
git commit -m "<concise message describing what changed>"
```

Write a real commit message summarizing the actual changes (not "deploy"). End the message with the standard trailer:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

If `git commit` reports nothing to commit, that's fine — continue to the push steps (there may still be unpushed commits).

## 4. Push to main

Determine the current branch:

```bash
git rev-parse --abbrev-ref HEAD
```

### Case A — already on `main`

```bash
git push origin main
```

If the branch has no upstream yet, use `git push -u origin main`.

### Case B — on a branch other than `main`

Commit on the current branch (step 3 already did this), then:

```bash
git push -u origin <current-branch>        # push the feature branch to remote
git checkout main
git merge <current-branch>                 # merge feature branch into main
git push origin main                        # push main to remote
```

Then return to the original branch so the working state is unchanged:

```bash
git checkout <current-branch>
```

## Notes

- The remote is `origin`. If a push is rejected because the remote has commits you don't (non-fast-forward), stop and report it — pull/rebase is a judgment call, not part of the automatic flow. Do **not** force-push.
- If the merge in Case B produces conflicts, stop and surface them; don't guess at resolutions.
- Report a short summary at the end: which docs changed, the commit hash/message, and what was pushed where.
