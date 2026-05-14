# Changelog

All notable changes are documented here. This project loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
