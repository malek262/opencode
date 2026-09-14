# Fork automation

Agent and release automation for `malek262/opencode`.

## OpenCode GitHub agent

Runs entirely in this repo's GitHub Actions via `anomalyco/opencode/github@latest`
in `use_github_token` mode (no external app dependency). Model config lives in
`.opencode/opencode.jsonc` (MiniMax, OpenAI-compatible endpoint); the key is stored
in the `MINIMAX_API_KEY` repo secret.

| Workflow | Trigger | Model | Purpose |
| --- | --- | --- | --- |
| `opencode-review.yml` | PR opened / synchronize / reopened / ready | `minimax/MiniMax-M3` | Automatic review with a `VERDICT:` line; comments only, never pushes |
| `opencode.yml` (opencode job) | Comment containing `/oc` or `/opencode` on an issue or PR | `minimax/MiniMax-M2.7-highspeed` | Interactive agent: explain, triage, fix (may branch + open a PR) |
| `opencode.yml` (triage job) | Issue opened | `minimax/MiniMax-M2.7-highspeed` | One short triage comment: affected area, missing repro steps |

Only actors with write access can trigger the agent. Upstream housekeeping
workflows (auto-close bots, discord notifications, publishing, etc.) are
disabled at the Actions settings level on this fork; re-check them after
upstream syncs since newly added workflow files arrive enabled.

## Release notes

`release-notes.yml` regenerates the changelog section of every published
release (GitHub generate-notes API against the previous tag) and is idempotent
via the `<!-- auto-notes -->` marker. It can be re-run manually with
`workflow_dispatch` and a tag input. Curated `## Highlights` sections above the
marker are preserved.

## Branch policy

`sidebar-navigation` is the default and release branch: force pushes and
deletions are blocked (admins may still push directly for release commits).
`sidebar-navigation-pr` holds the upstream PR (#48526) and must not be deleted.
