# SFTP Folder Diff

A VSCode extension that compares an **entire local folder** against a **remote SFTP folder** as a single operation — not file by file. Think FreeFileSync or Beyond Compare, but living inside VSCode.

![status](https://img.shields.io/badge/status-beta-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Recursive directory comparison** — local workspace ↔ remote SFTP folder, in one pass
- **Two compare modes**
  - `fast` — by size + mtime (seconds, even on large trees)
  - `content` — by SHA-256 hash (accurate, slower; downloads remote files for hashing)
- **Two views**, sharing the same diff data
  - Sidebar tree view (like Git Source Control)
  - WebView table view with size/mtime side-by-side, color badges, live path filter
- **Inline actions** per file: Diff / Upload / Download / Delete
- **Right-click anywhere** for single-file or folder operations
  - File: Diff with Remote / Upload / Download
  - Folder: Compare / Upload Folder / Download Folder
  - Editor tab and editor area menus too
- **Friendly progress** — byte-level percentage on single-file transfers, animated spinner with elapsed time on directory transfers, phased messages during compare (`Scanning local... → Scanning remote... → Comparing... → Hashing 142/1530`)
- **glob exclude** — supports `*`, `**`, `?`, bare names, exact paths
- **Temporary password** — if config has no password, you're prompted once per session and it stays in memory only

## Quick start

1. Install the `.vsix` from [Releases](../../releases)
   ```bash
   code --install-extension sftp-folder-diff-0.6.0.vsix
   ```
2. Open your local project
3. Run command `SFTP Diff: Configure Connection`, fill in `.vscode/sftp-diff.json`
4. Click the diff icon in the activity bar → click the refresh button

## Configuration

`.vscode/sftp-diff.json`:

```jsonc
{
  "host": "example.com",
  "port": 22,
  "username": "user",
  "password": "",                  // leave empty → prompted at runtime
  "privateKeyPath": "",            // takes precedence over password
  "remotePath": "/var/www/project",
  "localPath": ".",
  "exclude": [
    "node_modules", ".git", "*.log", "**/temp/*"
  ]
}
```

See [`USAGE.md`](./USAGE.md) for full docs, all commands, all settings, exclude syntax, security notes, troubleshooting.

## Commands

| Command | What it does |
|---|---|
| `SFTP Diff: Configure Connection` | Create/open `.vscode/sftp-diff.json` |
| `SFTP Diff: Compare Folders Now` | Compare whole `localPath` ↔ `remotePath` |
| `SFTP Diff: Compare This Folder` | (Right-click) compare a subfolder only |
| `SFTP Diff: Show as Table` | Open WebView table view |
| `SFTP Diff: Toggle Compare Mode` | Switch fast ↔ content |
| `SFTP Diff: Clear Session Password` | Wipe the in-memory password |
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
└── webviewPanel.ts    # main-editor table view
```

## Status & limitations

This is a beta. Working: everything listed above. Known not implemented:

- Symlinks are skipped
- Only the first workspace folder is used
- Recursive directory upload/download don't honor `exclude` (built-in ssh2-sftp-client limitation; would need a custom walker)
- No file watcher / auto-compare
- No bulk "upload all modified" / "download all"

## License

MIT — see [`LICENSE`](./LICENSE).
