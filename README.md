# SFTP Folder Diff

A VSCode extension that compares an **entire local folder** against a **remote SFTP folder** as a single operation — not file by file. Think FreeFileSync or Beyond Compare, but living inside VSCode.

![status](https://img.shields.io/badge/status-beta-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Recursive directory comparison** — local workspace ↔ remote SFTP folder, in one pass
- **Three compare modes**
  - `fast` — by size + mtime only (seconds, even on large trees; may flag identical files as modified when mtime drifts)
  - `smart` *(default)* — size + mtime first; falls back to SHA-256 only when mtime drifts. Fast for the common case, accurate for the rest
  - `content` — by SHA-256 hash unconditionally (accurate, slower; downloads remote files for hashing)
- **Auto-reconnect** — survives idle SFTP disconnects with a keepalive + transparent retry, so long compares and follow-up actions don't fail mid-run
- **Multi-target** — configure several SFTP servers + local↔remote mappings in one `.vscode/sftp-diff.json`; each target gets its own row in the sidebar and its own diff state
- **Per-target sidebar tree** — single source of truth, target nodes expand into nested folder/file diffs
- **Inline actions** per target (↻ recompare) and per file (Diff / Upload / Download / Delete)
- **Right-click anywhere** for single-file or folder operations; the target is auto-resolved from the path
  - File: Diff with Remote / Upload / Download
  - Folder: Compare / Upload Folder / Download Folder
  - Editor tab and editor area menus too
- **Friendly progress** — byte-level percentage on single-file transfers, animated spinner with elapsed time on directory transfers, phased messages during compare (`Scanning local... → Scanning remote... → Comparing... → Hashing 142/1530`)
- **Cancellable compare + folder transfer** — click the ✕ on the progress notification to abort; previous results are kept (compare) or partial transfers are preserved (folder upload/download)
- **Auto-reveal results** — compare jumps straight to the diff sidebar on completion, no extra click
- **Folder transfer progress** — recursive upload/download shows `N/M files · X / Y · pct% · current/path` and honors the same `exclude` rules as compare
- **glob exclude** — supports `*`, `**`, `?`, bare names, exact paths
- **Temporary password** — if config has no password, you're prompted once per session and it stays in memory only

## Quick start

1. Install the `.vsix` from [Releases](../../releases)
   ```bash
   code --install-extension sftp-folder-diff-0.8.0.vsix
   ```
2. Open your local project
3. Run command `SFTP Diff: Configure Connection`, fill in `.vscode/sftp-diff.json`
4. Click the diff icon in the activity bar → click the ↻ button on each target row to run that target's compare. Or right-click a file/folder under any target's `localPath` to invoke per-file SFTP actions.

## Configuration

`.vscode/sftp-diff.json`:

```jsonc
[
  {
    "name": "api",
    "host": "example.com",
    "port": 22,
    "username": "user",
    "password": "",
    "privateKeyPath": "",
    "remotePath": "/var/www/api",
    "localPath": "./api",
    "exclude": ["node_modules", ".git", "*.log"]
  },
  {
    "name": "widget",
    "host": "example.com",
    "username": "user",
    "remotePath": "/var/www/widget",
    "localPath": "./widget"
  }
]
```

See [`USAGE.md`](./USAGE.md) for full docs, all commands, all settings, exclude syntax, security notes, troubleshooting.

## Commands

| Command | What it does |
|---|---|
| `SFTP Diff: Configure Connection` | Create/open `.vscode/sftp-diff.json` |
| `SFTP Diff: Compare This Target` | (Per-target ↻ in sidebar) compare one target's whole tree |
| `SFTP Diff: Compare This Folder` | (Right-click) scope a compare to a subfolder; auto-resolves the target |
| `SFTP Diff: Clear Diff for This Target` | (Right-click target row) wipes that target's diff list; doesn't re-compare |
| `SFTP Diff: Disconnect This Target` | (Right-click target row) closes the SFTP connection for that target |
| `SFTP Diff: Toggle Compare Mode` | Cycle through fast → smart → content |
| `SFTP Diff: Clear Session Password` | Wipe in-memory passwords, disconnect all targets |
| `SFTP: Diff This File with Remote` | (Right-click file or editor) |
| `SFTP: Upload This File to Remote` | Same |
| `SFTP: Download This File from Remote` | Same |
| `SFTP: Upload This Folder to Remote` | (Right-click folder) |
| `SFTP: Download This Folder from Remote` | Same |

## Build from source

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Press `F5` in VSCode to launch an Extension Development Host for debugging.

## Project structure

```
src/
├── extension.ts       # entry point, command handlers, session password
├── sftpService.ts     # ssh2-sftp-client wrapper with progress callbacks
├── diffEngine.ts      # recursive scan + 3-way comparison
├── globMatcher.ts     # minimal glob (zero deps)
├── treeView.ts        # sidebar tree
└── targetRegistry.ts  # per-target state (sftp, lastDiff, inFlight)
```

## Status & limitations

This is a beta. Working: everything listed above. Known not implemented:

- Symlinks are skipped
- Only the first workspace folder is used
- No file watcher / auto-compare
- No bulk "upload all modified" / "download all"

## License

MIT — see [`LICENSE`](./LICENSE).
