# zen-bookmarks

Read and manage the [Zen browser](https://zen-browser.app) sidebar—pinned tabs, folders, and workspaces—from one command-line interface.

Zen stores this sidebar state in `zen-sessions.jsonlz4` inside the browser profile. `zen-bookmarks` can inspect the latest on-disk snapshot while Zen is open, though very recent UI changes may not appear until Zen saves them. Before a write, it offers to quit Zen gracefully, reloads the final shutdown state, writes a validated backup and atomic replacement while Zen is closed, then offers to reopen it.

> This project manages Zen's pinned sidebar, not Firefox-style bookmarks stored in `places.sqlite`.

## Features

- Read-only status, list, verify, and export commands work while Zen is open
- Full CRUD for pinned sidebar bookmarks, folders, and workspaces
- JSON output with stable Zen IDs for scripting and unambiguous targeting
- Interactive Zen lifecycle management for writes on macOS
- Timestamped backup before every write
- Optimistic concurrency check, structural validation, durable temporary write, and atomic rename
- JSON, YAML, and Netscape HTML exports
- Netscape HTML import that reuses existing tabs by pinned URL
- Zero runtime dependencies; Bun is the only runtime

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Zen Browser on macOS

Profile discovery currently scans `~/Library/Application Support/zen/Profiles`. Use `--sessions <path>` for an explicit session file or `--profile <substring>` to select among multiple profiles.

## Install

```bash
git clone https://github.com/wyattjoh/zen-bookmarks.git
cd zen-bookmarks
bun link
```

You can also run the source directly:

```bash
bun zen-bookmarks.ts --help
```

Runtime commands have no package dependencies. Contributors should run `bun install` for TypeScript and test declarations.

## Safety model

Read-only commands never close Zen:

```bash
zen-bookmarks status
zen-bookmarks list
zen-bookmarks verify
zen-bookmarks export
```

Write commands follow this sequence:

1. If Zen is open, ask whether to quit it and continue.
2. Ask macOS to quit Zen normally and wait for the process to exit.
3. Reload the final session state saved during shutdown.
4. Apply and structurally validate the mutation.
5. Confirm the source file did not change concurrently.
6. Save `zen-sessions.jsonlz4.bak-<timestamp>` beside the source.
7. Flush a temporary file and atomically rename it over the source.
8. If Zen was open initially, ask whether to reopen it.

Use `--dry-run` to validate and summarize any mutation without closing Zen or writing files. For automation, `--yes` accepts the lifecycle prompts and reopens Zen if it was previously running. `--no-reopen` overrides the latter behavior.

## Read and export

```bash
zen-bookmarks status
zen-bookmarks list
zen-bookmarks list --verbose
zen-bookmarks list --json
zen-bookmarks verify
zen-bookmarks export --out ./exports
```

Human-readable lists include workspace, folder, and bookmark IDs. Use those IDs for reliable mutations when names or URLs are duplicated.

## Bookmark CRUD

```bash
# Create
zen-bookmarks bookmark add \
  --url "https://example.com" \
  --title "Example" \
  --workspace Personal \
  --folder Reading

# Update by stable ID
zen-bookmarks bookmark update \
  --id "1740000000000-1" \
  --title "Example Docs" \
  --url "https://example.com/docs"

# Update by old URL
zen-bookmarks bookmark update \
  --match-url "https://example.com" \
  --url "https://example.com/docs"

# Move (destination is appended)
zen-bookmarks bookmark move \
  --id "1740000000000-1" \
  --workspace Work \
  --folder References

# Remove
zen-bookmarks bookmark remove --id "1740000000000-1"
```

Use `--source-workspace` and `--source-folder` to narrow a move selector. URL selectors that match multiple pins require `--all` for removal; update and move require a unique match.

## Folder CRUD

```bash
zen-bookmarks folder add --name Projects --workspace Work
zen-bookmarks folder add --name Active --workspace Work --parent Projects

zen-bookmarks folder update \
  --id "1740000000000-2" \
  --workspace Work \
  --name "Active Projects"

zen-bookmarks folder move \
  --id "1740000000000-2" \
  --workspace Work \
  --to-workspace Personal \
  --parent Reading

zen-bookmarks folder remove \
  --id "1740000000000-2" \
  --workspace Personal \
  --recursive
```

Folder moves append the folder to the destination. Removing a non-empty folder requires `--recursive`. Operations refuse to alter folders referenced by active split-view data.

## Workspace CRUD

```bash
zen-bookmarks workspace add --name Research
zen-bookmarks workspace update --workspace Research --name "R&D"
zen-bookmarks workspace move --workspace "R&D" --index 0
zen-bookmarks workspace remove --workspace "R&D"
```

Removing a non-empty workspace requires `--recursive`, and the final workspace cannot be removed. Recursive removal also removes tabs owned by that workspace, so use a dry run and backup deliberately.

## HTML import

```bash
zen-bookmarks import-html \
  --file bookmarks.html \
  --workspace Personal \
  --dry-run

zen-bookmarks import-html \
  --file bookmarks.html \
  --workspace Personal
```

Import rebuilds the selected workspace's pinned tree. Existing pins are reused by pinned URL so their session identity and available history are retained. Other workspaces remain untouched.

## Global options

- `--sessions <path>`: use an explicit `zen-sessions.jsonlz4`
- `--profile <substring>`: select a profile directory
- `--dry-run`: validate without writing or closing Zen
- `--json`: machine-readable output where supported
- `--yes`: accept quit/reopen prompts
- `--reopen`: always reopen a previously running Zen
- `--no-reopen`: do not reopen Zen

## Compatibility commands

The original entry points remain available:

```bash
bun extract-bookmarks.ts
bun update-bookmarks.ts list
bun update-bookmarks.ts verify
bun update-bookmarks.ts add --url "https://example.com"
bun update-bookmarks.ts add --url "https://example.com" --apply
```

Without `--apply`, legacy mutation commands now perform an in-memory dry run rather than writing a preview file. With `--apply`, they use the new interactive close/write/reopen lifecycle.

## How it works

The session file is a Mozilla `mozLz4` container: `mozLz40\0`, a little-endian decompressed size, and a raw LZ4 block. `mozlz4.ts` reads normal compressed blocks and writes a valid all-literal block without a runtime dependency.

Zen represents pinned tabs as session tab records. A pin references its workspace through `zenWorkspace`, a folder through `groupId`, and its stable identity through `zenSyncId`. Folder nesting uses `parentId`; the CLI preserves unknown fields and the rest of the session document verbatim.

Zen's session and sync formats continue to evolve. The CLI validates known invariants and keeps backups, but test changes with `--dry-run` and retain backups when upgrading Zen.

## Development

```bash
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE)
