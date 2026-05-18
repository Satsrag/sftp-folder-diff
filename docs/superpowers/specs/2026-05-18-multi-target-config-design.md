# Multi-target Config — Design

**Date:** 2026-05-18
**Target release:** 0.8.0
**Status:** Draft for review

## Problem

`.vscode/sftp-diff.json` currently holds one server + one `localPath`↔`remotePath` pair. Real workflows often need several at once: one workspace, multiple deployable subdirectories (e.g. `./api` → server A, `./widget` → server B). Today users have to either rewrite their config and re-compare between sessions, or split the work into multiple VSCode workspaces. Both are friction.

## Goals

- One workspace, multiple SFTP "targets" (each = server + credentials + one `localPath`↔`remotePath` mapping + its own exclude list), all configured in a single `.vscode/sftp-diff.json` file.
- Each target's diff results live independently — no cross-contamination, no overwrite.
- Right-click on any file or folder under a configured `localPath` automatically dispatches to the matching target; the user does not pick from a list.
- Tree view groups results by target; each target row has its own refresh button.
- Local paths of different targets **must not overlap**, so dispatch is unambiguous.

## Non-goals

- Per-target compare-mode setting. `sftpFolderDiff.compareMode` remains a single workspace-level setting.
- Backward compatibility with the single-object schema. Users of 0.7.x must migrate by wrapping their existing object in `[ ... ]`.
- A separate WebView table view. It is removed as part of this change.
- A global "compare all targets" command/button. Compares are per-target only.
- Recursive folder upload/download honoring `exclude` (unchanged from current; see CLAUDE.md "Known gap").

## §1 — Config schema

`.vscode/sftp-diff.json` is now a **top-level JSON array**. Each element carries the same fields as the existing `SftpConfig`, plus a required `name`:

```jsonc
[
  {
    "name": "api",                      // required, unique within the array; used as UI label and internal key
    "host": "39.96.81.124",
    "port": 22,
    "username": "root",
    "password": "",
    "privateKeyPath": "",
    "remotePath": "/data/wwwroot/api",
    "localPath": "./api",
    "exclude": ["node_modules", ".git", ".vscode", "dist", "out", ".DS_Store", "*.log", "**/temp/*"]
  },
  {
    "name": "widget",
    "host": "39.96.81.123",
    "port": 22,
    "username": "root",
    "password": "",
    "privateKeyPath": "",
    "remotePath": "/data/wwwroot/widget",
    "localPath": "./widget",
    "exclude": ["node_modules", ".git", ".vscode", "dist", "out", ".DS_Store", "*.log", "**/temp/*"]
  }
]
```

### Validation (one pass on load)

The entire config is rejected if any check fails — partial loads are not allowed. On rejection, surface the first problem in an error toast (don't flood). Checks, in order:

1. JSON parses.
2. Top-level value is an array with at least one element.
3. Every element has non-empty `name`, `host`, `username`, `remotePath`. `port` defaults to 22 if absent. Either `password`, `privateKeyPath`, or neither (prompt at runtime) is acceptable.
4. `name` is unique across the array.
5. **Local-path overlap check.** For each element, resolve `path.resolve(workspaceRoot, cfg.localPath || '.')` to an absolute, normalized path. For every unordered pair `(i, j)` where `i != j`, fail if `localBase[i]` equals `localBase[j]`, or one is a proper prefix of the other (treating both as directory paths). Examples that fail: `./api` vs `./api/sub`, `.` vs `./api`. Examples that pass: `./api` vs `./widget`.

The error message names the offending indices and paths, e.g. `targets[0] and targets[1] have overlapping localPath: /workspace/api ⊂ /workspace/api/sub`.

### No backward compatibility

A top-level object (the 0.7.x shape) is rejected with `expected an array; wrap your existing config in [ ... ]`. CHANGELOG 0.8.0 includes a copy-paste migration snippet.

## §2 — Data model

A new module `src/targetRegistry.ts` centralizes target state. The module-level globals in `extension.ts` (`sftp`, `lastDiff`, `sessionPassword`) go away.

```ts
interface Target {
  key: string;             // == config.name (unique by validation)
  config: SftpConfig;      // name/host/port/username/password/privateKeyPath/remotePath/localPath/exclude
  localBaseAbs: string;    // path.resolve(workspaceRoot, config.localPath) — produced during validation
  sftp?: SftpService;      // lazy: created on first op
  lastDiff: DiffEntry[];   // empty until first compare
  compared: boolean;       // false = never compared (distinct from "compared, 0 diffs")
  inFlight: boolean;       // true while a compare is running, used for same-target debounce
}

class TargetRegistry {
  private targets: Map<string, Target>;          // key → Target, ordered by config array
  private passwordCache: Map<string, string>;    // "host:port:username" → in-memory password

  load(): { ok: boolean; errors: string[] };     // (re)read .vscode/sftp-diff.json; preserves prior on failure
  list(): Target[];                              // ordered list for tree rendering
  get(key: string): Target | undefined;
  findByLocalPath(absPath: string): Target | undefined;  // matches when absPath is at or under target.localBaseAbs
  getOrConnectSftp(target: Target): Promise<SftpService>; // lazy connect with cached password
  removeDiff(target: Target, relPath: string): void;     // upload/download/delete success bookkeeping
  clearTargetDiff(target: Target): void;                 // user-invoked "Clear Diff"
  disconnectTarget(target: Target): Promise<void>;       // user-invoked "Disconnect"
  clearAll(): Promise<void>;                             // deactivate / global clearPassword
}
```

### How state differs from 0.7.x

| 0.7.x                                              | 0.8.0                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `sftp: SftpService \| null` module-level singleton | `target.sftp` per target, lazy                                       |
| `lastDiff: DiffEntry[]` module-level               | `target.lastDiff` per target                                         |
| `sessionPassword: string \| undefined`             | `passwordCache: Map<host:port:user, string>`, shared across targets  |
| `cfg = readConfig()` read on every command         | `registry.load()` on activate + on config file change                |

### Password cache scope

Targets sharing the same `host:port:username` triple share one cached password. First prompt fills the entry; subsequent targets reuse silently. Auth-shaped errors (`/auth|password|permission/i`) for a target clear only that cache entry, not the whole map.

### Hot reload

`vscode.workspace.createFileSystemWatcher('.vscode/sftp-diff.json')` listens for `onDidChange` and `onDidCreate`. The handler calls `registry.load()`:

- **Parse/validation failure:** keep prior `targets` map intact; show toast with the first problem; tree continues to render prior state. This avoids losing already-loaded state mid-edit.
- **Success:** swap to new targets. For any target that disappeared (key in old map not in new), `disconnect()` its `sftp` and drop its `lastDiff`. If that target had `inFlight === true`, the in-progress compare will surface an error when its SFTP connection closes mid-call; this is acceptable since the target is gone anyway. For targets that survived (matching name), preserve `lastDiff` + `compared` + `sftp` + `inFlight` so an in-progress workflow isn't reset. New targets start empty (`compared: false`, `inFlight: false`, no `sftp`). Tree refreshes.

### Path resolution

`localBaseAbs = path.resolve(workspaceRoot, cfg.localPath || '.')`. Symlinks are **not** resolved (consistent with current behavior; revisit only if asked). Remote paths stay POSIX, joined with explicit `/`.

## §3 — Command dispatch

### Commands with a URI argument (right-click file/folder, editor tab, editor body)

Affected commands: `diffFile`, `uploadFile`, `downloadFile`, `compareFolder`, `uploadFolder`, `downloadFolder`. The file-level commands (`diffFile` / `uploadFile` / `downloadFile`) also fall back to the active editor's URI when invoked from the command palette without a URI argument — this fallback path uses the same `findByLocalPath` dispatch on the active editor's `fsPath`. Folder commands (`compareFolder` / `uploadFolder` / `downloadFolder`) require an explicit folder URI (palette invocation without one shows `no folder selected`).

Entry handler shape:

```ts
const fsPath = resolveTargetPath(uri);           // existing helper
const target = registry.findByLocalPath(fsPath); // new
if (!target) {
  vscode.window.showErrorMessage(`path "${fsPath}" is not under any configured target`);
  return;
}
const mapped = mapLocalToRemote(target, fsPath); // signature changes to take target
// ...existing logic with target.config and registry.getOrConnectSftp(target)
```

`mapLocalToRemote` becomes `mapLocalToRemote(target: Target, localAbs: string)` and uses `target.localBaseAbs` + `target.config.remotePath`.

### Commands on a tree node

Tree nodes carry an `entry: DiffEntry`. `DiffEntry` gains a required `targetKey: string` field. Handlers (`openDiff`, `upload`, `download`, `deleteLocal`, `deleteRemote`) resolve `registry.get(node.entry.targetKey)` and proceed unchanged.

### New commands

- `sftpFolderDiff.compareTarget` — receives a `TargetNode`, runs `compareTarget(target)`. Wired as `view/item/context` inline button on `viewItem == targetRoot`.
- `sftpFolderDiff.clearTargetDiff` — receives a `TargetNode`, calls `registry.clearTargetDiff(target)`, fires tree refresh.
- `sftpFolderDiff.disconnectTarget` — receives a `TargetNode`, calls `registry.disconnectTarget(target)`.

Both `clearTargetDiff` and `disconnectTarget` live in `targetRoot`'s right-click context menu, not as inline buttons (kept off-canvas to reduce tree clutter — only ↻ is inline).

### Deleted commands

- `sftpFolderDiff.compare` — the global "Compare Folders Now" entry, both palette and `view/title`.
- `sftpFolderDiff.showTable` — removed along with the WebView panel.

### Surviving global commands (palette only, no `view/title` button)

- `sftpFolderDiff.configure` — unchanged.
- `sftpFolderDiff.clearPassword` — now clears the whole `passwordCache` map and disconnects every target.
- `sftpFolderDiff.toggleMode` — unchanged (still global workspace setting).

### `view/title`

Only `⚙ toggleMode` remains. `↻` and `▦` buttons removed.

## §4 — Tree UI

Two-level structure:

```
SFTP FOLDER DIFF       [⚙]
├─ ▶ api      root@39.96.81.124:/data/wwwroot/api    [↻]
│    ▼ src/
│        handler.ts                                  M
│        util.ts                                     L only
│    config.json                                     R only
└─ ▶ widget   root@39.96.81.123:/data/wwwroot/widget [↻]
     (not compared yet)
```

### Target node

- `label` = `target.config.name`
- `description` = `{username}@{host}:{remotePath}` truncated for narrow sidebars
- `tooltip` = full host/user/local/remote/exclude
- `contextValue` = `'targetRoot'`
- `collapsibleState`: `Expanded` if the target has been compared, otherwise `Collapsed`
- Inline button: `sftpFolderDiff.compareTarget` (the only inline)
- Right-click menu: `Clear Diff`, `Disconnect`

### Target node's children

- `target.compared === false` → single placeholder child `(not compared yet)`, non-clickable
- `target.compared === true && target.lastDiff.length === 0` → placeholder child `(no differences ✨)`
- `target.lastDiff.length > 0` → reuse the existing `buildTree(entries)` helper. The nested folder/file hierarchy is identical to today's per-workspace behavior. `DiffNode`s under a target carry `entry.targetKey === target.key`.

### File node

`contextValue` remains `modified | localOnly | remoteOnly`. `viewItem` regex matching in `view/item/context` is unchanged. The only difference: the command handlers, when called with a `DiffNode`, read `node.entry.targetKey` and resolve the target through the registry.

### Empty state

`registry.list().length === 0` (no config / empty array / parse failed and there was no prior state) → set `TreeView.message = "No targets configured. Run SFTP Diff: Configure Connection."`. The tree itself is empty.

### Auto-focus on compare success

Existing behavior preserved: after a successful per-target compare, `vscode.commands.executeCommand('sftpFolderDiff.tree.focus')` reveals the sidebar. Cancellation and errors do not focus.

### `package.json` snippets (illustrative)

```jsonc
"view/item/context": [
  { "command": "sftpFolderDiff.compareTarget",    "when": "view == sftpFolderDiff.tree && viewItem == targetRoot", "group": "inline@1" },
  { "command": "sftpFolderDiff.clearTargetDiff",  "when": "view == sftpFolderDiff.tree && viewItem == targetRoot", "group": "1_modification@1" },
  { "command": "sftpFolderDiff.disconnectTarget", "when": "view == sftpFolderDiff.tree && viewItem == targetRoot", "group": "1_modification@2" },
  // file-level entries unchanged
  { "command": "sftpFolderDiff.openDiff",         "when": "view == sftpFolderDiff.tree && viewItem =~ /modified|localOnly|remoteOnly/", "group": "inline@1" },
  // ...
]
```

## §5 — Failure modes

### Config load failure

Reject the whole config; preserve prior state if any; toast the first error. Tree continues to render whatever was loaded last. If there was no prior state, fall back to the empty-state placeholder.

### Hot reload edge cases

- File deleted: registry clears all targets, disconnects them. Tree goes to empty state.
- File rewritten with malformed JSON: prior state preserved; user sees a toast and can keep editing.
- File rewritten with renamed target (`name` change): treated as old target removed + new target added. Previously cached `lastDiff` and `sftp` for the renamed target are discarded.

### Per-target connection failure

Caught in the command handler that called `registry.getOrConnectSftp(target)`. Auth-shaped error clears the password cache entry for `host:port:user`, the next attempt re-prompts. Network errors surface verbatim. Other targets unaffected.

### Cancel

Per-target `withProgress({cancellable: true})` with its own `CancellationToken`. There is no "cancel all" entry point — by design, since there is no "compare all" entry point either.

### Same-target debounce

When `sftpFolderDiff.compareTarget(target)` is invoked, the handler checks `target.inFlight`. If true: `showInformationMessage(\`${target.config.name} compare already running.\`)` and return. Otherwise set `inFlight = true`, run, finally set `inFlight = false` in a `try/finally`.

### Cross-target concurrency

Two different targets can compare concurrently. Each gets its own progress notification, cancellation token, and SFTP connection. State is partitioned by target so there is no shared mutable to race on. SFTP connections are **not** pooled across targets, even when several targets share the same `host:port:username`: each target owns its own `target.sftp` instance. Only the cached password (`passwordCache`) is shared across same-credential targets, to skip duplicate prompts.

### SFTP idle reconnect

Already implemented in `SftpService` (0.7.0). Per target, the SFTP wrapper transparently reconnects on disconnect-shaped errors. Multi-target does not change the wrapper.

## §6 — Deletion list and breaking changes

### Removed code

- `src/webviewPanel.ts` — whole file deleted.
- `extension.ts`:
  - module-level `sftp`, `lastDiff`, `sessionPassword` — replaced by the registry
  - `readConfig`, `getEffectiveExclude`, `mapLocalToRemote` (current single-target), `summarizeDiff` (target-aware version moves into the success toast), `compareCmd` (global), `showTableCmd`, `removeEntry`
  - all `DiffWebviewPanel.refresh / show` calls
- `package.json`:
  - commands `sftpFolderDiff.compare`, `sftpFolderDiff.showTable`
  - `view/title` entries for the above
- Single-object schema parse path.

### Added code

- `src/targetRegistry.ts` — new module described in §2.
- `package.json` commands: `sftpFolderDiff.compareTarget`, `sftpFolderDiff.clearTargetDiff`, `sftpFolderDiff.disconnectTarget`.
- File watcher in `activate()`.

### Modified code

- `src/diffEngine.ts` — `DiffEntry` gains required `targetKey: string`. The engine itself takes `targetKey` in the constructor and writes it to every emitted entry. No other engine behavior changes.
- `src/treeView.ts` — provider rewritten to emit a two-level tree (target nodes + per-target file subtrees). `buildTree(entries)` helper kept and reused under each target.
- `src/extension.ts` — command handlers refactored to dispatch via `registry.findByLocalPath` (URI commands) or `registry.get(node.entry.targetKey)` (tree commands).
- `src/sftpService.ts` — unchanged.

### Breaking changes (user-visible)

1. Config schema is now an array. Old single-object configs fail to load with a clear migration message.
2. WebView table view is gone. The `▦` button and "SFTP Diff: Show as Table" command no longer exist.
3. The global "Compare Folders Now" command and the `↻` button on the view title bar are gone. Refresh is per-target only, on each target row in the tree.

### Version

Target **0.8.0**. The breaking changes preclude a patch release; 1.0 is reserved for an explicit stability commitment.

### Migration guide (CHANGELOG 0.8.0 will include)

```jsonc
// Before (0.7.x)
{
  "host": "39.96.81.124",
  "username": "root",
  "remotePath": "/data/wwwroot/api",
  "localPath": "./api",
  "exclude": [...]
}

// After (0.8.0) — wrap in an array, add a name
[
  {
    "name": "api",
    "host": "39.96.81.124",
    "username": "root",
    "remotePath": "/data/wwwroot/api",
    "localPath": "./api",
    "exclude": [...]
  }
]
```

Docs to update: `README.md`, `USAGE.md` (both bilingual), `CHANGELOG.md`, `CLAUDE.md`.

## Open questions

None at design-approval time. Implementation plan will surface concrete file-level steps next.
