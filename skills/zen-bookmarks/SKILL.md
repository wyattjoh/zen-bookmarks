---
name: zen-bookmarks
description: Operates the zen-bookmarks CLI to inspect and manage Zen Browser's pinned sidebar, including bookmarks, folders, and workspaces. Use when asked to "list Zen bookmarks", "manage Zen sidebar pins", "add or move a Zen bookmark", "manage Zen folders or workspaces", "import bookmarks into Zen", "export Zen bookmarks", or interact with `zen-bookmarks`, `zen-sessions.jsonlz4`, or Zen profile sidebar data.
license: MIT
compatibility: Requires macOS, Zen Browser, and Bun 1.0 or newer. The `zen-bookmarks` executable must be linked or run from this repository with `bun zen-bookmarks.ts`.
---

# Zen Bookmarks CLI

Use the unified `zen-bookmarks` CLI to inspect or modify Zen Browser's pinned sidebar. It manages pinned tabs, folders, and workspaces in `zen-sessions.jsonlz4`; it does not manage Firefox-style bookmarks in `places.sqlite`.

## Choose the executable

Prefer the linked command:

```bash
zen-bookmarks --help
```

If it is unavailable and the current repository contains `zen-bookmarks.ts`, use:

```bash
bun zen-bookmarks.ts --help
```

Use the chosen form consistently. Do not run `bun link` or install anything unless the user asks. The CLI exposes only global help; do not expect command-specific `--help` output.

## Establish the session

Start with read-only discovery:

```bash
zen-bookmarks status --json
zen-bookmarks list --json
```

Profile discovery scans `~/Library/Application Support/zen/Profiles`. If discovery is ambiguous, ask the user to choose rather than guessing:

```bash
zen-bookmarks status --profile "profile-substring" --json
zen-bookmarks status --sessions "/absolute/path/to/zen-sessions.jsonlz4" --json
```

After resolving a profile, prefer the exact `path` returned by `status --json` as `--sessions <path>` on subsequent commands. This prevents later commands from targeting a different profile.

Read commands work while Zen is open, although very recent UI changes may not appear until Zen saves them.

## Inspect before changing

Use machine-readable output for reasoning and stable IDs for mutations:

```bash
zen-bookmarks list --sessions "$SESSION" --json
zen-bookmarks verify --sessions "$SESSION" --json
```

Use `list --verbose` only when a human-readable tree with URLs is more useful. Names and URLs may be duplicated; prefer workspace, folder, and bookmark IDs from `list --json`.

`verify` exits nonzero when the mozLz4 round trip is lossy or structural validation fails. Do not mutate an invalid session unless the user explicitly accepts the risk after seeing the failure.

## Apply mutations safely

For every bookmark, folder, workspace, or HTML-import mutation:

1. Resolve and retain the exact session path.
2. Inspect the current tree and identify targets by stable ID.
3. Run the complete command with `--dry-run --json`.
4. Show the dry-run summary and exact target to the user.
5. Obtain confirmation before the real write.
6. Run the same command without `--dry-run`, adding `--yes` only after that confirmation.
7. Report the returned `backupPath` and summary.
8. Run `verify --json` and re-list the affected area.

Example:

```bash
zen-bookmarks bookmark update \
  --sessions "$SESSION" \
  --id "bookmark-id" \
  --title "Example Docs" \
  --url "https://example.com/docs" \
  --dry-run \
  --json
```

After confirmation:

```bash
zen-bookmarks bookmark update \
  --sessions "$SESSION" \
  --id "bookmark-id" \
  --title "Example Docs" \
  --url "https://example.com/docs" \
  --yes \
  --json
```

A real write may gracefully quit Zen, reload its final saved state, validate the mutation, create `zen-sessions.jsonlz4.bak-<timestamp>`, atomically replace the source, and reopen Zen if it was running. Use `--no-reopen` when the user wants Zen left closed. Do not use `--yes`, `--reopen`, or `--no-reopen` without understanding and honoring the user's lifecycle preference.

Never edit or replace `zen-sessions.jsonlz4` directly.

## Bookmark commands

```bash
# Add
zen-bookmarks bookmark add --url <url> [--title <title>] [--workspace <id-or-name>] [--folder <id-or-name>]

# Update; --url is the new URL here
zen-bookmarks bookmark update (--id <id> | --match-url <old-url>) [--title <title>] [--url <new-url>]

# Move; --url is a selector here
zen-bookmarks bookmark move (--id <id> | --url <url>) [--workspace <destination>] [--folder <destination>]

# Remove
zen-bookmarks bookmark remove (--id <id> | --url <url>) [--all]
```

For move selectors, use `--source-workspace` and `--source-folder` to disambiguate the source. Moves append to the destination. URL removal that matches multiple pins requires `--all`; do not add `--all` without explicit user intent. Update and move require a unique match.

## Folder commands

```bash
zen-bookmarks folder add --name <name> [--workspace <workspace>] [--parent <folder>]
zen-bookmarks folder update (--id <id> | --folder <name>) --name <new-name> [--workspace <workspace>]
zen-bookmarks folder move (--id <id> | --folder <name>) [--workspace <source>] [--to-workspace <destination>] [--parent <folder>]
zen-bookmarks folder remove (--id <id> | --folder <name>) [--workspace <workspace>] [--recursive]
```

Folder moves append to the destination. Removing a non-empty folder requires `--recursive`. Never infer recursive deletion from a general cleanup request; confirm the folder contents and user intent. The CLI refuses to alter folders referenced by active split-view data.

## Workspace commands

```bash
zen-bookmarks workspace add --name <name>
zen-bookmarks workspace update (--id <id> | --workspace <name>) --name <new-name>
zen-bookmarks workspace move (--id <id> | --workspace <name>) --index <zero-based-index>
zen-bookmarks workspace remove (--id <id> | --workspace <name>) [--recursive]
```

Workspace indexes are zero-based. A non-empty workspace requires `--recursive` for removal, and the final workspace cannot be removed. Recursive removal also removes that workspace's tabs; enumerate them and obtain explicit confirmation first.

## Import and export

Export is read-only with respect to Zen but writes three files to the output directory:

```bash
zen-bookmarks export --sessions "$SESSION" --out <directory> --json
```

It writes `bookmarks.json`, `bookmarks.yaml`, and `bookmarks.html`.

HTML import rebuilds the selected workspace's pinned tree and is a mutation, so follow the dry-run workflow:

```bash
zen-bookmarks import-html \
  --sessions "$SESSION" \
  --file <bookmarks.html> \
  --workspace <id-or-name> \
  --dry-run \
  --json
```

Import preserves other workspaces and reuses existing pinned tabs by URL where possible.

## Handle failures

- Preserve stderr and the process exit code; do not claim success from stdout alone.
- If profile selection is ambiguous, ask for `--profile` or an explicit `--sessions` path.
- If a selector is ambiguous, re-list and use an ID or narrower source selectors.
- If validation or optimistic concurrency checks fail, stop and re-read current state; never retry a stale mutation blindly.
- If Zen restarts before a write, stop and repeat discovery plus dry-run against the newly saved state.
- Do not delete timestamped backups unless the user explicitly requests it.

The legacy `extract-bookmarks.ts` and `update-bookmarks.ts` entry points remain compatible, but use the unified CLI for new work.
