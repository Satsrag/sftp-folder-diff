# Changelog

All notable changes are documented here. This project loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.8.0] – 2026-05-18

### Added
- **Multi-target config.** `.vscode/sftp-diff.json` is now a top-level JSON array; each element is an independent SFTP target with its own server, credentials, local↔remote mapping, and exclude list. Each target requires a unique `name` and a `localPath` that does not overlap any other target's `localPath`.
- **Per-target tree view.** The sidebar groups results by target. Each target row has an inline ↻ to recompare just that target, plus right-click actions `Clear Diff` and `Disconnect`. File-level inline actions (Diff / Upload / Download / Delete) work as before, scoped to their owning target.
- **Right-click path dispatch.** Right-clicking a file or folder under any target's `localPath` automatically resolves to that target — no QuickPick.
- **Config hot reload.** Editing `.vscode/sftp-diff.json` reloads targets without restarting the window. Parse/validation failures preserve the prior loaded state and toast the first error.
- **Per-target same-target debounce.** Hitting ↻ a second time while a compare is running for that target shows a notice and ignores the second click. Different targets can compare concurrently.

### Changed
- **Breaking — config schema:** single-object configs from 0.7.x no longer load. Wrap your existing object in `[ { ... } ]` and add a `"name"` field. See migration snippet below.
- **Breaking — WebView removed:** the table view (`▦` button and `SFTP Diff: Show as Table` command) is gone. The tree view is the only diff UI.
- **Breaking — global Compare button removed:** the `↻` button on the sidebar title bar and the `SFTP Diff: Compare Folders Now` command are gone. Use the per-target ↻ on each target row, or right-click a folder under a target's local path.
- Session passwords are now cached per `host:port:username` triple (shared across targets with the same credentials).

### Migration

```jsonc
// Before (0.7.x)
{
  "host": "example.com",
  "username": "user",
  "remotePath": "/var/www",
  "localPath": ".",
  "exclude": ["node_modules"]
}

// After (0.8.0) — wrap in an array; add a name
[
  {
    "name": "default",
    "host": "example.com",
    "username": "user",
    "remotePath": "/var/www",
    "localPath": ".",
    "exclude": ["node_modules"]
  }
]
```

## [0.7.1] – 2026-05-18

### Added
- **Cancellable compare** — the progress notification now shows a ✕ button; click it to abort a long compare. `DiffEngine.run` accepts a cancellation callback that is checked between phases, on every walked directory entry, and on each compare-loop iteration. Previous diff results are preserved on cancel.
- **Auto-reveal results** — when a compare completes successfully the SFTP Folder Diff sidebar is automatically focused so results are visible without an extra activity-bar click. Cancellation and errors do not change the focus.

## [0.7.0] – 2026-05-18

### Added
- **`smart` compare mode** (new default) — combines `fast` and `content`: size mismatch → modified immediately (no hash); size + mtime both agree → trusted as identical (no hash); size matches but mtime drifts → SHA-256 hash to confirm. Eliminates the false-positive "modified" entries from `fast` mode when deploy scripts / `git checkout` / FS-precision differences shift mtime on identical files, without paying the full content-mode cost for every file.
- Toggle command now cycles **fast → smart → content → fast**.

### Changed
- Default `sftpFolderDiff.compareMode` is now `smart` (was `fast`). Existing workspaces with the setting explicitly set are unaffected.

### Fixed
- **SFTP connection survives idle disconnects.** Long compares or follow-up actions used to fail with "no sftp connection" after the SSH session was reaped by the server. The wrapper now:
  - sends a keepalive every 30 s (`keepaliveInterval`) so live sessions don't get reaped in the first place;
  - listens for `close` / `end` / `error` events and marks itself disconnected;
  - transparently reconnects + retries any op once on a disconnect-shaped error (`ECONNRESET`, `ETIMEDOUT`, `not connected`, etc.);
  - single-flights the reconnect so concurrent ops share one attempt.

## [0.6.0] – 2026-05-14

### Added
- Friendly progress reporting
  - Single-file transfers (diff fetch / upload / download) show `1.2 MB / 4.7 MB · 25%` with a real progress bar
  - Directory upload/download show an animated Braille spinner and elapsed `mm:ss`
  - Compare goes through phases: `🔌 Connecting → 📂 Scanning local: N files in M dirs → 🌐 Scanning remote → 🔍 Comparing X/Y` (and `Hashing X/Y: path` in content mode)
- Compare-complete summary now reads `18 modified, 5 local-only, 4 remote-only` instead of a single count

## [0.5.0] – 2026-05-14

### Added
- Right-click on a file in Explorer (or in the editor tab / editor body): **Diff with Remote**, **Upload to Remote**, **Download from Remote**
- Right-click on a folder: **Upload Folder to Remote**, **Download Folder from Remote** (alongside existing **Compare This Folder**)

## [0.4.0] – 2026-05-14

### Added
- Click any node in the diff tree to view it:
  - `modified` → side-by-side diff editor (Remote ↔ Local)
  - `localOnly` → opens the local file
  - `remoteOnly` → downloads remote into a temp file and opens it (read-only preview)
- Inline "View" / "Diff" buttons for all three statuses in both tree and table views

### Fixed
- Diff editor now preserves the original filename + extension in the temp path, so syntax highlighting works correctly

## [0.3.0] – 2026-05-14

### Added
- `exclude` config in `.vscode/sftp-diff.json` with glob support (`*`, `**`, `?`, bare names, exact paths); takes precedence over the global `sftpFolderDiff.ignore` setting
- Temporary in-memory password — if config has neither `password` nor `privateKeyPath`, the user is prompted once per session; never written to disk
- `SFTP Diff: Clear Session Password` command
- Right-click folder in Explorer → **SFTP Diff: Compare This Folder** to scope a compare to a subtree
- Minimal zero-dep glob matcher (`src/globMatcher.ts`)

## [0.2.0] – 2026-05-14

### Added
- WebView table view as alternative to sidebar tree — side-by-side remote/local columns with size, mtime, status badges, action buttons, and live path filter
- Tree view and table view share data and refresh together after operations

## [0.1.0] – 2026-05-14

### Added
- Initial release
- Recursive folder comparison via SFTP (ssh2-sftp-client)
- Two compare modes: `fast` (size + mtime), `content` (SHA-256 hash)
- Sidebar tree view with three statuses (modified / localOnly / remoteOnly)
- Inline actions: open diff, upload, download, delete (with confirmation)
- Configurable ignore list
