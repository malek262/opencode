# Fork automation

Agent, CI, and release automation for `malek262/opencode`.

## PR pipeline

```
pull_request ──► pr-checks.yml
                   ├─ typecheck                (bun turbo typecheck)
                   ├─ unit (linux)             (bun turbo test + check:generated + httpapi gates)
                   ├─ e2e (linux)              (playwright, quarantine via --grep-invert,
                   │                            artifacts: playwright-report, test-results, junit xml)
                   ├─ Test results             (mikepenz/action-junit-report check + PR comment)
                   └─ Required                 (aggregate gate — the only required status check)

pr-checks failed ──► ci-doctor.yml (workflow_run)
                       resolve PR → gh run view --log-failed (≤60 KB)
                       → MiniMax-M3 + .github/prompts/ci-failure.md
                       → one sticky `<!-- ci-doctor -->` comment (updated, never spammed)

pull_request ──► opencode-review.yml
                   MiniMax-M3 + .github/prompts/pr-review.md
                   → advisory verdict: PRELIMINARY APPROVE / CHANGES REQUESTED
                   (never a formal GitHub approval; the owner decides)
```

Branch protection on `sidebar-navigation` requires the single `Required` check
for PR merges and blocks force-pushes/deletions. Direct pushes by the owner
bypass required checks (admin) and feed the release pipeline.

### e2e quarantine

Three specs fail on GitHub runners for environmental reasons even on clean
pre-fork code (verified with a probe branch). They are excluded from the PR
gate via `--grep-invert` in `pr-checks.yml`:

- `redirects a draft to the legacy new-session route`
- `renders comment strips and historical diff summary overflow`
- `keeps the review tree and terminal sized when both panels are open`

Keep this list in sync with the comment in `pr-checks.yml` and the ci-doctor
prompt template. They still run (non-gating) in `fork-desktop-linux.yml`.

## OpenCode GitHub agent

Runs entirely in this repo's GitHub Actions via `anomalyco/opencode/github@latest`
in `use_github_token` mode (no external app dependency). Model config lives in
`.opencode/opencode.jsonc` (MiniMax, OpenAI-compatible endpoint
`api.minimaxi.com/v1`); the key is stored in the `MINIMAX_API_KEY` repo secret.

| Workflow | Trigger | Model | Purpose |
| --- | --- | --- | --- |
| `opencode-review.yml` | PR opened / synchronize / reopened / ready | `minimax/MiniMax-M3` | Advisory review from `.github/prompts/pr-review.md` |
| `ci-doctor.yml` | `pr-checks` run failed | `MiniMax-M3` (direct API) | Sticky failure-analysis comment from `.github/prompts/ci-failure.md` |
| `opencode.yml` (opencode job) | Comment containing `/oc` or `/opencode` | `minimax/MiniMax-M2.7-highspeed` | Interactive agent: explain, triage, fix (may branch + open a PR) |
| `opencode.yml` (triage job) | Issue opened | `minimax/MiniMax-M2.7-highspeed` | One short triage comment: affected area, missing repro steps |

Prompt templates live in `.github/prompts/` — edit the markdown, not the YAML.
Only actors with write access can trigger the agent. `ci-doctor` checks out the
default branch only (never PR code) because it holds secrets.

Upstream housekeeping workflows (auto-close bots, discord notifications,
publishing, etc.) are disabled at the Actions settings level on this fork;
re-check them after upstream syncs since newly added workflow files arrive
enabled.

## Release pipeline

`fork-desktop-linux.yml` runs on pushes to `sidebar-navigation` only:
typecheck + unit + e2e (non-gating) → desktop build → CLI build → prerelease
`v1.18.30-sidebar.<run>` with AppImage/deb/rpm/latest-linux.yml and
`opencode-cli-linux-x64`. `release-notes.yml` then regenerates the changelog
section of the published release (idempotent via the `<!-- auto-notes -->`
marker; manual re-run through `workflow_dispatch`). Curated `## Highlights`
above the marker are preserved.

## Branch policy

`sidebar-navigation` is the default and release branch. `sidebar-navigation-pr`
holds the upstream PR (#48526) and must not be deleted. Feature work should go
through PRs so `pr-checks`, `ci-doctor`, and `opencode-review` all engage.
