# zen-bookmarks

Extract, parse, and rewrite the [Zen browser](https://zen-browser.app) sidebar (pinned tabs, folders, and workspaces) as portable JSON, YAML, or Netscape HTML, then write your reorganized layout back into Zen.

Zen does not store these "bookmarks" in Firefox's `places.sqlite`. Your pinned sidebar tabs, the folders you group them into, and your workspaces all live in a single compressed session file, `zen-sessions.jsonlz4`. This project reads that file, reconstructs the workspace / folder / bookmark tree, and can rebuild it from an edited export.

## Features

- Export your full sidebar to JSON (hierarchical), YAML, or Netscape bookmark HTML (re-importable into any browser)
- Reorganize visually in any bookmark editor, then import the structure back into Zen
- Reuses existing pinned tabs by URL on import, so favicons and history are preserved
- Add or remove individual bookmarks from the command line
- Safe by default: never writes to Zen while it is running, always backs up first, and writes atomically
- Zero dependencies, single runtime (Bun)

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Zen browser (tested on macOS)

Auto-detection of the active profile is macOS-only for now. On other platforms, pass `--sessions <path>` to point at your `zen-sessions.jsonlz4` (Linux: `~/.zen/<profile>/`, Windows: `%APPDATA%\zen\Profiles\<profile>\`).

## Install

```bash
git clone https://github.com/wyattjoh/zen-bookmarks.git
cd zen-bookmarks
```

No `bun install` needed; there are no dependencies.

## Usage

### Export

```bash
bun extract-bookmarks.ts
```

Writes `bookmarks.json`, `bookmarks.yaml`, and `bookmarks.html` to the current directory. Options:

- `--sessions <path>`: read a specific session file instead of auto-detecting
- `--out <dir>`: write the exports somewhere other than the current directory

### Inspect and verify (read-only)

```bash
bun update-bookmarks.ts list      # print the workspace / folder / bookmark tree
bun update-bookmarks.ts verify    # confirm the read/write round-trip is lossless
```

### Add or remove a single bookmark

By default these write a preview file and do not touch Zen. Add `--apply` (with Zen quit) to write for real.

```bash
bun update-bookmarks.ts add --url "https://example.com" --title "Example" \
  --workspace Personal --folder News

bun update-bookmarks.ts remove --url "https://example.com" --apply
```

### Reorganize the whole sidebar (round trip)

1. Export: `bun extract-bookmarks.ts`
2. Open `bookmarks.html` in any tool that reads Netscape bookmarks, and rearrange folders and bookmarks however you like.
3. Quit Zen completely.
4. Import the new structure into a workspace:

```bash
bun update-bookmarks.ts import-html --file bookmarks.html --workspace Personal --apply
```

`import-html` rebuilds the target workspace to match the file. It matches each bookmark to your existing pinned tab by URL (keeping its favicon and history), creates fresh tabs only for new URLs, and drops any pinned tab in that workspace the file no longer lists. Other workspaces and your open (non-pinned) tabs are left untouched.

## Output formats

- JSON: nested `workspace -> folders -> bookmarks`, best for programmatic use
- YAML: the same tree, easier to read and hand-edit
- Netscape HTML: the standard `bookmarks.html` format, re-importable into any browser and editable in bookmark managers

When a pinned tab has navigated away from its pinned target, the export records the pinned URL as `url` and the live location as `currentUrl`, so nothing is lost.

## How it works

Zen's session file is a Mozilla `mozLz4` container: the magic bytes `mozLz40\0`, a little-endian uint32 of the decompressed size, then a raw LZ4 block. `mozlz4.ts` decompresses it and, for writes, re-encodes the JSON as an all-literal LZ4 block (valid, dependency-free, and byte-for-byte reversible since the container carries no checksum).

Inside, the sidebar is a flat, ordered list of pinned tabs. Each folder is a tab group; a tab belongs to a folder via its `groupId`, and folders nest via `parentId`. Folder render order and nesting are reconstructed from array order plus each folder's `prevSiblingInfo`, matching Zen's own restore logic.

## Safety

- `--apply` refuses to run while Zen is open, because Zen overwrites the session file on its own save timer and on shutdown; edits made while it runs would be lost.
- Every `--apply` backs up the original to `zen-sessions.jsonlz4.bak-<timestamp>` next to it, then writes atomically (temp file plus rename).
- Your Zen sidebar is not synced to Firefox Sync, so local edits do not fight a cloud reconciliation. (Firefox Sync only covers `places` bookmarks, history, and prefs.)

Restore a backup at any time by copying it back over `zen-sessions.jsonlz4` while Zen is quit.

## Caveats

- Tested against current Zen on macOS. Zen is evolving software, and its session format can change between releases. Always keep the backups.
- Profile auto-detection is macOS-only; use `--sessions` elsewhere.
- Folder ordering on import is reconstructed from reverse-engineered rules. It is validated structurally, but if anything looks out of order after import, restore the backup and open an issue.

## Contributing

Issues and pull requests are welcome, especially cross-platform profile detection and testing against new Zen releases.

## License

[MIT](LICENSE)
