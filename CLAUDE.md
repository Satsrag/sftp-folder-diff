# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VSCode extension (`publisher: satsrag`, id `sftp-folder-diff`) that compares an entire local folder against a remote SFTP folder in one pass, then exposes diff/upload/download/delete actions per file. Targets `vscode ^1.75.0`, TypeScript strict mode, single runtime dependency: `ssh2-sftp-client`.

## Commands

| | |
|---|---|
| Install deps | `npm install` |
| Compile (one-shot) | `npm run compile` *(runs `tsc -p ./`, outputs to `./out`)* |
| Compile (watch) | `npm run watch` |
| Package `.vsix` | `npx --yes @vscode/vsce package --allow-missing-repository` |
| Launch dev host | Press **F5** in VSCode |

There is **no test suite, no linter, and no formatter configured.** Don't go looking — none exists yet. If asked to add tests, propose a framework first.

`out/extension.js` is the compiled entry (`package.json` `main`). It must be present for the extension to load — always recompile after edits before testing.

## Release flow

Tag-driven via `.github/workflows/release.yml`:

1. Bump `version` in `package.json`.
2. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. GitHub Actions compiles, packages the `.vsix`, and attaches it to a generated release.

Manual run available from the Actions tab (`workflow_dispatch`).

## Architecture

The whole extension is 6 files in `src/`. The interesting cross-file invariants:

**Single source of truth**: `extension.ts` holds `lastDiff: DiffEntry[]` (module-level). Both the tree view (`treeView.ts`) and the WebView table (`webviewPanel.ts`) are stateless renderers fed from it. After any mutation (upload/download/delete), `removeEntry()` rewrites `lastDiff` and calls **both** `treeProvider.refreshAfterChange()` and `DiffWebviewPanel.refresh()` so the two views stay in sync. Don't update one without the other.

**`DiffEntry` is the universal currency** (see `diffEngine.ts`). Three statuses (`localOnly | remoteOnly | modified`) drive icons, badges, available context-menu actions, and the `viewItem` regex matching in `package.json`'s `view/item/context`. Adding a new status means touching: `diffEngine.ts` (emit it), `treeView.ts` (icon + describe), `webviewPanel.ts` (badge + buttons), and `package.json` (`view/item/context` `when` clauses).

**WebView → extension communication** uses VSCode commands via a fake-node trampoline. The WebView posts `{action, relPath}`; the panel resolves it to a `DiffEntry`, wraps it as `{ entry }`, and calls `vscode.commands.executeCommand('sftpFolderDiff.openDiff', fakeNode)`. The same command handlers therefore serve the real tree's `DiffNode` and the WebView's synthetic node — both have a `.entry` property. Preserve that contract.

**Compare mode toggle** is a VSCode setting (`sftpFolderDiff.compareMode`), not internal state — read on every `compareCmd` call. Three modes (default `smart`):
- `fast` — size + mtime within 2000 ms drift. Fastest, but mtime is unreliable in many real-world flows (deploy scripts, `git checkout`, FS precision, clock drift) — so this mode produces lots of false-positive `modified` entries when contents are actually identical.
- `smart` — size + mtime first; if both agree, trust them; if size matches but mtime drifts, fall back to SHA-256 to confirm. Most files take the fast path; only the mtime-drifted minority get hashed. Recommended default.
- `content` — size first, then SHA-256 unconditionally (remote downloaded into memory via `sftp.readBuffer`). Slowest, most accurate.

`filesEqual()` in `diffEngine.ts` is the only place this branches; the size-mismatch short-circuit is shared by all three modes.

**Path mapping** (`mapLocalToRemote` in `extension.ts`): every local abs path is resolved against `localBase` (= `workspaceRoot / cfg.localPath`) and the relative tail is joined onto `cfg.remotePath` with **POSIX** separators. Anything outside `localBase` is rejected. The same mapping is applied — with `localBase` and `remoteBase` both rewritten — when a sub-folder compare is launched (`compareCmd(subFolderAbs)`).

**Exclude resolution**: `cfg.exclude` from `.vscode/sftp-diff.json` wins if non-empty; otherwise fall back to VSCode setting `sftpFolderDiff.ignore`. Matching is delegated to `globMatcher.ts` — a zero-dep matcher that supports `*`, `**`, `?`, exact paths, and **bare names match any path segment** (gitignore-style: `node_modules` matches `src/node_modules/x`).

**Known gap**: recursive folder upload/download (`uploadDir` / `downloadDir`) uses ssh2-sftp-client's built-ins and **does not honor `exclude`**. Don't promise it does. Fixing would require writing a custom walker on top of `sftpService.list` + `fastPut`/`fastGet`.

## Security-sensitive design — don't break this

The session password (`sessionPassword` in `extension.ts`) is held in module-level memory only and is **never** written to disk, SecretStorage, or the OS keychain. This is intentional, documented in USAGE.md, and a selling point. Do not "improve" it by persisting to SecretStorage without an explicit request.

**Auth priority** in `ensureConnected()`: `cfg.privateKeyPath` (wins if non-empty) → `cfg.password` (from config file) → prompted once per VSCode session and cached in `sessionPassword`. On an auth-shaped error (`/auth|password|permission/i`), `sessionPassword` is cleared so the next attempt re-prompts. `deactivate()` and `clearPasswordCmd` both wipe it.

`.vscode/sftp-diff.json` is in `.gitignore` because the repo itself can be used as a test workspace — never commit it.

## Progress UX convention

Two helpers in `extension.ts`:
- `withTransferProgress(op, filename, work)` — single-file ops, reports `X / Y · pct%` from a `step` callback wired into ssh2's `fastGet`/`fastPut`. Throttled to ≥80 ms between updates.
- `withSpinnerProgress(title, work)` — recursive folder ops, animated Braille spinner + `mm:ss` elapsed.

Compare progress is bespoke — phases are pushed through a single `progress: (msg) => void` callback from `DiffEngine.run`. Tick throttling: 150 ms during scanning, 100 ms while hashing, 200 ms while comparing.

## Conventions to follow

- Remote paths are POSIX (`/`), local paths are platform-native; use `path.join` for local and explicit `'/'` concat for remote (`joinRemote` in `diffEngine.ts`).
- Symlinks are deliberately skipped (`e.type === '-'` filter in `walkRemote`; only `isFile()` accepted in `walkLocal`). If asked to support them, surface it as a behavior change, not a bugfix.
- Only the first workspace folder (`workspaceFolders[0]`) is used. Multi-root is not supported.
- README/USAGE/CHANGELOG/PUBLISH docs are bilingual (中文 + English). Match the existing pattern if editing them.
