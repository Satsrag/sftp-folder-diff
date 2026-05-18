# Multi-target Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-target SFTP config + WebView table view with a multi-target array config and a target-grouped tree view, per the design at `docs/superpowers/specs/2026-05-18-multi-target-config-design.md`. Release as 0.8.0 with a breaking-change migration note.

**Architecture:** Introduce `src/targetRegistry.ts` that owns all per-target state (SFTP connection, lastDiff, in-flight flag) plus a shared `host:port:user` password cache. Module-level state in `extension.ts` (`sftp`, `lastDiff`, `sessionPassword`) goes away. `DiffEntry` carries `targetKey`. Tree view renders two levels: target roots + per-target file subtrees. WebView panel deleted. Compare dispatches via right-click path lookup or per-target inline ↻ button.

**Tech Stack:** TypeScript 5.x, VSCode extension API (≥1.75), ssh2-sftp-client 10.x. **No test framework** — verification is `npm run compile` plus F5 Extension Development Host smoke testing.

---

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/targetRegistry.ts` | **Create** | `Target` type, `TargetRegistry` class: config load + validation + per-target state + password cache + sftp lazy connect |
| `src/diffEngine.ts` | Modify | Add required `targetKey: string` to `DiffEntry`; `DiffEngine` ctor takes `targetKey`; written into every emitted entry |
| `src/treeView.ts` | Modify | Provider rewritten to two-level tree: target roots + reused `buildTree` for per-target file subtrees |
| `src/extension.ts` | Modify | Drop module-level `sftp` / `lastDiff` / `sessionPassword` and `readConfig` / `mapLocalToRemote` / `compareCmd` / `summarizeDiff` / `showTableCmd`. Wire `TargetRegistry`. Refactor all command handlers to dispatch via `registry.findByLocalPath` (URI commands) or `entry.targetKey` (tree commands). Add new `compareTarget` / `clearTargetDiff` / `disconnectTarget` commands and a config file watcher |
| `src/webviewPanel.ts` | **Delete** | WebView removed entirely |
| `src/sftpService.ts` | Unchanged | — |
| `src/globMatcher.ts` | Unchanged | — |
| `package.json` | Modify | Delete `sftpFolderDiff.compare` + `sftpFolderDiff.showTable` + their `view/title` entries. Add `compareTarget`, `clearTargetDiff`, `disconnectTarget`. Update `view/item/context` for `targetRoot`. Bump version |
| `CHANGELOG.md` | Modify | 0.8.0 entry with migration snippet |
| `README.md` | Modify | Multi-target intro; remove WebView mentions; commands table refresh |
| `USAGE.md` | Modify | New config example + multi-target UI walkthrough; remove WebView section; bilingual |
| `CLAUDE.md` | Modify | Architecture section: single-source-of-truth → registry; remove WebView passages |

---

## Task 1: Create `TargetRegistry` (no wiring yet)

**Files:**
- Create: `src/targetRegistry.ts`

This task adds the new module without changing any existing behavior. After this task, the project still compiles and runs as 0.7.1; the registry is dead code until task 4 wires it in.

- [ ] **Step 1: Write `src/targetRegistry.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SftpService, SftpConfig } from './sftpService';
import { DiffEntry } from './diffEngine';

export interface Target {
  key: string;                              // == config.name (unique by validation)
  config: SftpConfig & { name: string };
  localBaseAbs: string;                     // path.resolve(workspaceRoot, config.localPath)
  sftp?: SftpService;                       // lazy: created on first op
  lastDiff: DiffEntry[];                    // [] until first compare
  compared: boolean;                        // false = never compared (distinct from "compared, 0 diffs")
  inFlight: boolean;                        // true while a compare is running on this target
}

export interface LoadResult {
  ok: boolean;
  errors: string[];                         // first error only when ok=false; [] otherwise
}

const CONFIG_RELATIVE = '.vscode/sftp-diff.json';

export class TargetRegistry {
  private targets: Map<string, Target> = new Map();
  private passwordCache: Map<string, string> = new Map();

  constructor(private workspaceRoot: string) {}

  /**
   * (Re)read .vscode/sftp-diff.json. On parse/validation failure, prior
   * state is preserved (no destructive side effects). On success, reconcile
   * new targets against existing map: surviving targets (same name + same
   * resolved localPath) keep their runtime state; renamed/moved/removed
   * targets get their sftp disconnected and lastDiff dropped.
   */
  load(): LoadResult {
    const configPath = path.join(this.workspaceRoot, CONFIG_RELATIVE);
    if (!fs.existsSync(configPath)) {
      // File gone — drop everything cleanly.
      this.disconnectAndClearAll();
      return { ok: false, errors: [`config file not found at ${CONFIG_RELATIVE}`] };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (e: any) {
      return { ok: false, errors: [`could not read config: ${e.message}`] };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      return { ok: false, errors: [`config is not valid JSON: ${e.message}`] };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, errors: ['expected an array; wrap your existing config in [ ... ]'] };
    }
    if (parsed.length === 0) {
      return { ok: false, errors: ['config array is empty; add at least one target'] };
    }

    // Per-element required-field check + localBaseAbs precompute.
    const validated: Array<{ cfg: SftpConfig & { name: string }; localBaseAbs: string }> = [];
    for (let i = 0; i < parsed.length; i++) {
      const e = parsed[i];
      if (!e || typeof e !== 'object') {
        return { ok: false, errors: [`targets[${i}]: expected an object`] };
      }
      const missing: string[] = [];
      if (!e.name || typeof e.name !== 'string') missing.push('name');
      if (!e.host || typeof e.host !== 'string') missing.push('host');
      if (!e.username || typeof e.username !== 'string') missing.push('username');
      if (!e.remotePath || typeof e.remotePath !== 'string') missing.push('remotePath');
      if (missing.length > 0) {
        return { ok: false, errors: [`targets[${i}]: missing required field(s): ${missing.join(', ')}`] };
      }
      const localBaseAbs = path.resolve(this.workspaceRoot, e.localPath || '.');
      validated.push({ cfg: e as SftpConfig & { name: string }, localBaseAbs });
    }

    // Name uniqueness.
    const seenNames = new Map<string, number>();
    for (let i = 0; i < validated.length; i++) {
      const n = validated[i].cfg.name;
      const earlier = seenNames.get(n);
      if (earlier !== undefined) {
        return {
          ok: false,
          errors: [`targets[${earlier}] and targets[${i}] have duplicate name "${n}"`],
        };
      }
      seenNames.set(n, i);
    }

    // Local-path overlap check (any pair where one is a prefix of the other).
    for (let i = 0; i < validated.length; i++) {
      for (let j = i + 1; j < validated.length; j++) {
        const a = validated[i].localBaseAbs;
        const b = validated[j].localBaseAbs;
        if (isAncestorOrEqual(a, b) || isAncestorOrEqual(b, a)) {
          return {
            ok: false,
            errors: [`targets[${i}] and targets[${j}] have overlapping localPath: ${a} ⊂ ${b}`],
          };
        }
      }
    }

    // All checks passed. Reconcile.
    const newMap = new Map<string, Target>();
    for (const v of validated) {
      const key = v.cfg.name;
      const existing = this.targets.get(key);
      if (existing && existing.localBaseAbs === v.localBaseAbs) {
        existing.config = v.cfg;
        newMap.set(key, existing);
      } else {
        if (existing) {
          // Same name but localBaseAbs changed — treat as renamed: drop runtime state.
          this.dropTargetState(existing);
        }
        newMap.set(key, {
          key,
          config: v.cfg,
          localBaseAbs: v.localBaseAbs,
          lastDiff: [],
          compared: false,
          inFlight: false,
        });
      }
    }

    // Disappeared targets: disconnect + drop.
    for (const [k, t] of this.targets) {
      if (!newMap.has(k)) {
        this.dropTargetState(t);
      }
    }

    this.targets = newMap;
    return { ok: true, errors: [] };
  }

  list(): Target[] {
    return [...this.targets.values()];
  }

  get(key: string): Target | undefined {
    return this.targets.get(key);
  }

  /**
   * Reverse-lookup a target by absolute filesystem path. Matches when
   * absPath is at or under target.localBaseAbs. With the overlap check
   * enforced by load(), at most one target can match.
   */
  findByLocalPath(absPath: string): Target | undefined {
    const resolved = path.resolve(absPath);
    for (const t of this.targets.values()) {
      if (resolved === t.localBaseAbs || isUnder(resolved, t.localBaseAbs)) {
        return t;
      }
    }
    return undefined;
  }

  /**
   * Ensure target.sftp is connected and ready. Lazy-creates the SftpService,
   * resolves the password via cfg.privateKeyPath > cfg.password > prompt+cache,
   * and on auth failure clears the cache entry so the next attempt re-prompts.
   */
  async getOrConnectSftp(target: Target): Promise<SftpService> {
    if (!target.sftp) target.sftp = new SftpService();
    const cfg = target.config;
    const hasKey = !!(cfg.privateKeyPath && cfg.privateKeyPath.trim());
    const hasCfgPwd = !!(cfg.password && cfg.password.length > 0);
    const credKey = `${cfg.host}:${cfg.port ?? 22}:${cfg.username}`;
    const runtime: SftpConfig = { ...cfg };

    if (!hasKey && !hasCfgPwd) {
      let pwd = this.passwordCache.get(credKey);
      if (!pwd) {
        const entered = await vscode.window.showInputBox({
          prompt: `SFTP password for ${cfg.username}@${cfg.host}`,
          password: true,
          ignoreFocusOut: true,
          placeHolder: 'kept in memory only for this VSCode session',
        });
        if (!entered) throw new Error('no password entered');
        pwd = entered;
        this.passwordCache.set(credKey, pwd);
      }
      runtime.password = pwd;
    }

    try {
      await target.sftp.connect(runtime);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/auth|password|permission/i.test(msg) && !hasKey && !hasCfgPwd) {
        this.passwordCache.delete(credKey);
      }
      throw e;
    }
    return target.sftp;
  }

  removeDiff(target: Target, relPath: string): void {
    target.lastDiff = target.lastDiff.filter(e => e.relPath !== relPath);
  }

  clearTargetDiff(target: Target): void {
    target.lastDiff = [];
    target.compared = false;
  }

  async disconnectTarget(target: Target): Promise<void> {
    if (target.sftp) {
      try { await target.sftp.disconnect(); } catch { /* ignore */ }
      target.sftp = undefined;
    }
  }

  /** Used by deactivate() and the global clearPassword command. */
  async clearAll(): Promise<void> {
    for (const t of this.targets.values()) {
      await this.disconnectTarget(t);
    }
    this.passwordCache.clear();
  }

  private dropTargetState(target: Target): void {
    if (target.sftp) {
      target.sftp.disconnect().catch(() => { /* ignore */ });
      target.sftp = undefined;
    }
  }

  private disconnectAndClearAll(): void {
    for (const t of this.targets.values()) {
      this.dropTargetState(t);
    }
    this.targets.clear();
  }
}

function isAncestorOrEqual(maybeAncestor: string, child: string): boolean {
  if (maybeAncestor === child) return true;
  const withSep = maybeAncestor.endsWith(path.sep) ? maybeAncestor : maybeAncestor + path.sep;
  return child.startsWith(withSep);
}

function isUnder(child: string, parent: string): boolean {
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}
```

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: clean exit (no TS errors). The module is unused so nothing else is affected.

- [ ] **Step 3: Commit**

```bash
git add src/targetRegistry.ts
git commit -m "$(cat <<'EOF'
feat: add TargetRegistry module for multi-target config

New src/targetRegistry.ts holds the Target type and the registry class
that will own per-target state (sftp, lastDiff, inFlight) plus a shared
host:port:user password cache. Not yet wired into extension.ts — that
happens in the next set of tasks. Validation logic (top-level array,
required fields, unique name, non-overlapping localPath) is fully
implemented here.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `targetKey` to `DiffEntry` and `DiffEngine`

**Files:**
- Modify: `src/diffEngine.ts`
- Modify: `src/extension.ts` (one-line site that constructs `DiffEngine` — stays for now to keep compile green)

After this task, the codebase still operates in single-target mode; the new field is populated with the legacy sentinel `''` until task 4 plumbs real keys through.

- [ ] **Step 1: Update `DiffEntry` interface**

Edit `src/diffEngine.ts` near the top, in the `DiffEntry` interface:

```ts
export interface DiffEntry {
  relPath: string;
  status: DiffStatus;
  targetKey: string;     // NEW — identifies which Target this entry belongs to
  localAbs?: string;
  remoteAbs?: string;
  localSize?: number;
  remoteSize?: number;
  localMtime?: number;
  remoteMtime?: number;
}
```

- [ ] **Step 2: Update `DiffEngine` constructor**

```ts
export class DiffEngine {
  private matcher: GlobMatcher;
  constructor(
    private sftp: SftpService,
    private targetKey: string,            // NEW — passed through to every emitted entry
    private localBase: string,
    private remoteBase: string,
    ignore: string[],
    private mode: CompareMode,
  ) {
    this.matcher = new GlobMatcher(ignore);
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Set `targetKey` on every `results.push` site in `DiffEngine.run`**

There are **three** push sites in `run()`. Each gets `targetKey: this.targetKey` added.

Local-only branch (replace existing):

```ts
      if (!rf) {
        results.push({
          relPath: rel,
          status: 'localOnly',
          targetKey: this.targetKey,
          localAbs: lf.abs,
          remoteAbs: this.joinRemote(this.remoteBase, rel),
          localSize: lf.size,
          localMtime: lf.mtime,
        });
        continue;
      }
```

Modified branch (replace existing):

```ts
      if (!same) {
        results.push({
          relPath: rel,
          status: 'modified',
          targetKey: this.targetKey,
          localAbs: lf.abs,
          remoteAbs: rf.abs,
          localSize: lf.size,
          remoteSize: rf.size,
          localMtime: lf.mtime,
          remoteMtime: rf.mtime,
        });
      }
```

Remote-only branch (replace existing):

```ts
    for (const [rel, rf] of remoteMap) {
      if (!localMap.has(rel)) {
        results.push({
          relPath: rel,
          status: 'remoteOnly',
          targetKey: this.targetKey,
          remoteAbs: rf.abs,
          localAbs: path.join(this.localBase, rel),
          remoteSize: rf.size,
          remoteMtime: rf.mtime,
        });
      }
    }
```

- [ ] **Step 4: Update the single `new DiffEngine(...)` site in `src/extension.ts`**

In `extension.ts`'s `compareCmd`, the call currently reads:

```ts
const engine = new DiffEngine(conn, localBase, remoteBase, exclude, mode);
```

Add a `''` second argument so the compile stays green (task 4 replaces this entire function):

```ts
const engine = new DiffEngine(conn, '', localBase, remoteBase, exclude, mode);
```

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: clean exit. The `''` sentinel is fine because `compareCmd` itself is going away in task 4.

- [ ] **Step 6: Commit**

```bash
git add src/diffEngine.ts src/extension.ts
git commit -m "$(cat <<'EOF'
feat: thread targetKey through DiffEngine into DiffEntry

DiffEntry gains a required targetKey field; DiffEngine takes targetKey
in its constructor and writes it onto every emitted entry. The single
construction site in extension.ts passes an empty string for now; the
next task removes the global compareCmd entirely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete the WebView panel

**Files:**
- Delete: `src/webviewPanel.ts`
- Modify: `src/extension.ts` (remove all `DiffWebviewPanel` references and the `showTableCmd` handler)
- Modify: `package.json` (remove `sftpFolderDiff.showTable` command + the ▦ entry in `view/title`)

After this task, the WebView table view no longer exists. The sidebar tree is the only diff UI. Single-target compare still works.

- [ ] **Step 1: Delete the WebView source file**

```bash
git rm src/webviewPanel.ts
```

- [ ] **Step 2: Remove the import and command registration in `extension.ts`**

Delete this import line near the top:

```ts
import { DiffWebviewPanel } from './webviewPanel';
```

Delete this registration line inside `activate()`:

```ts
vscode.commands.registerCommand('sftpFolderDiff.showTable', showTableCmd),
```

Delete the entire `showTableCmd` function at the bottom of the file:

```ts
async function showTableCmd() {
  if (lastDiff.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      'No diff data yet. Run compare first?', 'Compare Now', 'Cancel'
    );
    if (pick === 'Compare Now') {
      await compareCmd();
    }
  }
  DiffWebviewPanel.show(_extensionUri, lastDiff);
}
```

- [ ] **Step 3: Remove `DiffWebviewPanel.refresh()` calls**

There are two `DiffWebviewPanel.refresh(lastDiff)` lines: one inside `compareCmd`'s `withProgress` callback, one inside `removeEntry`. Delete both.

- [ ] **Step 4: `_extensionUri` is now unused — delete the variable and its assignment**

Top of `extension.ts`:

```ts
let _extensionUri: vscode.Uri;
```

Inside `activate()`:

```ts
_extensionUri = context.extensionUri;
```

Delete both lines.

- [ ] **Step 5: Update `package.json` — remove the command and the ▦ button**

Inside `contributes.commands`, delete this object:

```json
{
  "command": "sftpFolderDiff.showTable",
  "title": "SFTP Diff: Show as Table",
  "icon": "$(table)"
}
```

Inside `contributes.menus["view/title"]`, delete this entry:

```json
{ "command": "sftpFolderDiff.showTable", "when": "view == sftpFolderDiff.tree", "group": "navigation@2" }
```

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: clean exit.

- [ ] **Step 7: Manual smoke (optional but recommended)**

Press F5 in VSCode. In the dev host: confirm the `▦` button is gone from the sidebar title; confirm `SFTP Diff: Show as Table` is gone from the command palette. Regular tree-view diff still works against a single-target config.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: remove WebView table view in prep for multi-target

WebView was a dual UI to the sidebar tree; with multi-target coming
we're collapsing to one UI. Deletes webviewPanel.ts, the showTable
command + ▦ title-bar button, the refresh() call sites, and the unused
_extensionUri variable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `extension.ts` + `treeView.ts` + `package.json` for multi-target

**Files:**
- Modify: `src/extension.ts` (substantial rewrite — module-level state replaced by `TargetRegistry`, all command handlers refactored, new commands added, config-file watcher added)
- Modify: `src/treeView.ts` (two-level tree)
- Modify: `package.json` (drop `sftpFolderDiff.compare` global, add `compareTarget` / `clearTargetDiff` / `disconnectTarget`, update `view/item/context`, drop the `↻` button from `view/title`)

This is the central task. It's larger than the others, but it has to be atomic: partial states leave the extension non-functional. The order below is: write `treeView.ts` first (it's purely a consumer of registry types — easy to compile in isolation), then `extension.ts` (the orchestrator), then `package.json` (UI glue).

Reference behavior: `docs/superpowers/specs/2026-05-18-multi-target-config-design.md` §3 and §4.

- [ ] **Step 1: Rewrite `src/treeView.ts`**

Full replacement (~150 lines). Replace the entire file with:

```ts
import * as vscode from 'vscode';
import { DiffEntry, DiffStatus } from './diffEngine';
import { Target } from './targetRegistry';

export class DiffNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly entry?: DiffEntry,
    public readonly target?: Target,
    public readonly children: DiffNode[] = [],
  ) {
    super(label, collapsibleState);

    if (target && !entry) {
      // Target root node
      this.contextValue = 'targetRoot';
      this.iconPath = new vscode.ThemeIcon('broadcast');
      this.description = `${target.config.username}@${target.config.host}:${target.config.remotePath}`;
      this.tooltip = [
        `name: ${target.config.name}`,
        `host: ${target.config.host}:${target.config.port ?? 22}`,
        `user: ${target.config.username}`,
        `local:  ${target.localBaseAbs}`,
        `remote: ${target.config.remotePath}`,
      ].join('\n');
      return;
    }

    if (entry) {
      this.contextValue = entry.status;
      this.description = describe(entry);
      this.iconPath = iconFor(entry.status);
      this.tooltip = `${entry.relPath}\n${entry.status}`;
      this.command = {
        command: 'sftpFolderDiff.openDiff',
        title: 'Open',
        arguments: [this],
      };
      return;
    }

    // Plain folder grouping node inside a target's subtree
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

function describe(e: DiffEntry): string {
  switch (e.status) {
    case 'modified':   return 'M';
    case 'localOnly':  return 'L only';
    case 'remoteOnly': return 'R only';
  }
}

function iconFor(s: DiffStatus): vscode.ThemeIcon {
  switch (s) {
    case 'modified':   return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    case 'localOnly':  return new vscode.ThemeIcon('diff-added',    new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    case 'remoteOnly': return new vscode.ThemeIcon('diff-removed',  new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
  }
}

/** Provider that emits a two-level tree: target roots → per-target file subtree. */
export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private _onDidChange = new vscode.EventEmitter<DiffNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private targets: Target[] = [];

  setTargets(targets: Target[]): void {
    this.targets = targets;
    this._onDidChange.fire(undefined);
  }

  /** Called after a single target's lastDiff changes (compare, upload, etc.) */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: DiffNode): vscode.TreeItem { return el; }

  getChildren(el?: DiffNode): DiffNode[] {
    if (!el) {
      // Root — one node per target, in config order.
      return this.targets.map(t => {
        const collapsed = t.compared
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
        return new DiffNode(t.config.name, collapsed, undefined, t);
      });
    }
    if (el.target && !el.entry) {
      // Target root expanded: build the per-target subtree.
      const t = el.target;
      if (!t.compared) {
        return [new DiffNode('(not compared yet)', vscode.TreeItemCollapsibleState.None)];
      }
      if (t.lastDiff.length === 0) {
        return [new DiffNode('(no differences ✨)', vscode.TreeItemCollapsibleState.None)];
      }
      return buildSubtree(t.lastDiff);
    }
    // Folder grouping node — return cached children.
    return el.children;
  }
}

/** Build a nested folder tree from a target's lastDiff. (Same shape as the old buildTree.) */
function buildSubtree(entries: DiffEntry[]): DiffNode[] {
  interface Dir { children: Map<string, Dir>; files: DiffEntry[]; }
  const root: Dir = { children: new Map(), files: [] };

  for (const e of entries) {
    const parts = e.relPath.split('/');
    parts.pop(); // file name; processed below
    let cur = root;
    for (const p of parts) {
      if (!cur.children.has(p)) cur.children.set(p, { children: new Map(), files: [] });
      cur = cur.children.get(p)!;
    }
    cur.files.push(e);
  }

  function toNodes(d: Dir): DiffNode[] {
    const out: DiffNode[] = [];
    const folderNames = [...d.children.keys()].sort();
    for (const name of folderNames) {
      const subNodes = toNodes(d.children.get(name)!);
      out.push(new DiffNode(name, vscode.TreeItemCollapsibleState.Expanded, undefined, undefined, subNodes));
    }
    d.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const e of d.files) {
      const fname = e.relPath.split('/').pop()!;
      out.push(new DiffNode(fname, vscode.TreeItemCollapsibleState.None, e));
    }
    return out;
  }
  return toNodes(root);
}
```

- [ ] **Step 2: Rewrite `src/extension.ts` — replace top section (imports, state, activate, progress helpers, common helpers)**

This step replaces the file's top-of-file declarations, `activate`, `deactivate`, and the two `withProgress` helpers (which stay untouched in behavior, just kept). The bottom section — all command handlers — gets rewritten in steps 3-6 below.

Replace the entire `src/extension.ts` file with the following. (Note: this is the **whole** file; all command handlers are included.)

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpService, SftpConfig } from './sftpService';
import { DiffEngine, DiffEntry } from './diffEngine';
import { DiffTreeProvider, DiffNode } from './treeView';
import { TargetRegistry, Target } from './targetRegistry';

const CONFIG_FILE = '.vscode/sftp-diff.json';

let treeProvider: DiffTreeProvider;
let registry: TargetRegistry;
let watcher: vscode.FileSystemWatcher | undefined;

/* ---------- progress helpers (unchanged from 0.7.1) ---------- */

async function withSpinnerProgress(title: string, work: () => Promise<void>): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async (progress) => {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      const start = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const mm = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const ss = (elapsed % 60).toString().padStart(2, '0');
        progress.report({ message: `${frames[i++ % frames.length]} working...  ${mm}:${ss} elapsed` });
      }, 120);
      try { await work(); } finally { clearInterval(timer); }
      progress.report({ message: '✓ done' });
    }
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function withTransferProgress(
  op: string,
  filename: string,
  work: (step: (transferred: number, total: number) => void) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${op} ${filename}`, cancellable: false },
    async (progress) => {
      let lastReported = 0;
      let total = 0;
      let lastTick = Date.now();
      const step = (transferred: number, t: number) => {
        total = t;
        const now = Date.now();
        if (now - lastTick < 80 && transferred < total) return;
        lastTick = now;
        const pct = total > 0 ? Math.floor((transferred / total) * 100) : 0;
        const delta = transferred - lastReported;
        lastReported = transferred;
        progress.report({
          message: `${fmtBytes(transferred)} / ${fmtBytes(total)} · ${pct}%`,
          increment: total > 0 ? (delta / total) * 100 : undefined,
        });
      };
      progress.report({ message: 'preparing...' });
      await work(step);
      progress.report({ message: '✓ done' });
    }
  );
}

/* ---------- activation ---------- */

export function activate(context: vscode.ExtensionContext) {
  const root = getWorkspaceRoot();
  registry = new TargetRegistry(root ?? '');
  if (root) {
    const result = registry.load();
    if (!result.ok) {
      // First-time users won't have a config yet — don't toast in that case.
      const configPath = path.join(root, CONFIG_FILE);
      if (fs.existsSync(configPath)) {
        vscode.window.showErrorMessage(`SFTP Diff config error: ${result.errors[0]}`);
      }
    }
  }

  treeProvider = new DiffTreeProvider();
  treeProvider.setTargets(registry.list());
  const view = vscode.window.createTreeView('sftpFolderDiff.tree', {
    treeDataProvider: treeProvider,
  });
  view.message = root ? undefined : 'Open a folder to use SFTP Folder Diff.';
  if (root && registry.list().length === 0) {
    view.message = 'No targets configured. Run SFTP Diff: Configure Connection.';
  }

  // Hot reload: watch .vscode/sftp-diff.json
  if (root) {
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, CONFIG_FILE)
    );
    const reload = () => {
      const r = registry.load();
      if (!r.ok) {
        vscode.window.showErrorMessage(`SFTP Diff config error: ${r.errors[0]}`);
      }
      treeProvider.setTargets(registry.list());
      view.message = registry.list().length === 0
        ? 'No targets configured. Run SFTP Diff: Configure Connection.'
        : undefined;
    };
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('sftpFolderDiff.configure', configureCmd),
    vscode.commands.registerCommand('sftpFolderDiff.compareFolder', compareFolderCmd),
    vscode.commands.registerCommand('sftpFolderDiff.compareTarget', compareTargetCmd),
    vscode.commands.registerCommand('sftpFolderDiff.clearTargetDiff', clearTargetDiffCmd),
    vscode.commands.registerCommand('sftpFolderDiff.disconnectTarget', disconnectTargetCmd),
    vscode.commands.registerCommand('sftpFolderDiff.diffFile', diffFileCmd),
    vscode.commands.registerCommand('sftpFolderDiff.uploadFile', uploadFileCmd),
    vscode.commands.registerCommand('sftpFolderDiff.downloadFile', downloadFileCmd),
    vscode.commands.registerCommand('sftpFolderDiff.uploadFolder', uploadFolderCmd),
    vscode.commands.registerCommand('sftpFolderDiff.downloadFolder', downloadFolderCmd),
    vscode.commands.registerCommand('sftpFolderDiff.toggleMode', toggleModeCmd),
    vscode.commands.registerCommand('sftpFolderDiff.clearPassword', clearPasswordCmd),
    vscode.commands.registerCommand('sftpFolderDiff.openDiff', openDiffCmd),
    vscode.commands.registerCommand('sftpFolderDiff.upload', uploadCmd),
    vscode.commands.registerCommand('sftpFolderDiff.download', downloadCmd),
    vscode.commands.registerCommand('sftpFolderDiff.deleteLocal', deleteLocalCmd),
    vscode.commands.registerCommand('sftpFolderDiff.deleteRemote', deleteRemoteCmd),
  );
}

export function deactivate() {
  registry?.clearAll();
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/* ---------- helpers ---------- */

/** Map a target + abs local path → posix remote path. Returns undefined + toasts on out-of-target. */
function mapLocalToRemote(target: Target, localAbs: string): { remoteAbs: string; relPath: string } | undefined {
  const rel = path.relative(target.localBaseAbs, path.resolve(localAbs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    vscode.window.showErrorMessage(`Path is outside target "${target.config.name}" (${target.localBaseAbs}): ${localAbs}`);
    return undefined;
  }
  const posixRel = rel.replace(/\\/g, '/');
  const remoteBase = target.config.remotePath;
  const remoteAbs = !posixRel
    ? remoteBase
    : remoteBase.endsWith('/')
      ? remoteBase + posixRel
      : remoteBase + '/' + posixRel;
  return { remoteAbs, relPath: posixRel };
}

/** Resolve URI argument or fall back to active editor. Toasts on failure. */
function resolveTargetPath(uri?: vscode.Uri): string | undefined {
  if (uri && uri.fsPath) return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active.fsPath;
  vscode.window.showErrorMessage('No file selected and no active editor.');
  return undefined;
}

/** Look up the target a path belongs to, or toast + return undefined. */
function targetForPath(absPath: string): Target | undefined {
  const t = registry.findByLocalPath(absPath);
  if (!t) {
    vscode.window.showErrorMessage(`Path "${absPath}" is not under any configured target.`);
    return undefined;
  }
  return t;
}

function summarizeDiff(entries: DiffEntry[]): string {
  if (entries.length === 0) return 'no differences ✨';
  const counts = { modified: 0, localOnly: 0, remoteOnly: 0 };
  for (const e of entries) counts[e.status]++;
  const parts: string[] = [];
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.localOnly) parts.push(`${counts.localOnly} local-only`);
  if (counts.remoteOnly) parts.push(`${counts.remoteOnly} remote-only`);
  return parts.join(', ');
}

function removeEntryFromTarget(target: Target, entry: DiffEntry): void {
  registry.removeDiff(target, entry.relPath);
  treeProvider.refresh();
}

/* ---------- global commands ---------- */

async function configureCmd() {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a folder first.');
    return;
  }
  const dir = path.join(root, '.vscode');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'sftp-diff.json');
  if (!fs.existsSync(target)) {
    const template = [
      {
        name: 'default',
        host: 'example.com',
        port: 22,
        username: 'user',
        password: '',
        privateKeyPath: '',
        remotePath: '/var/www/project',
        localPath: '.',
        exclude: ['node_modules', '.git', '.vscode', 'dist', 'out', '.DS_Store'],
      },
    ];
    fs.writeFileSync(target, JSON.stringify(template, null, 2));
  }
  const doc = await vscode.workspace.openTextDocument(target);
  vscode.window.showTextDocument(doc);
}

async function toggleModeCmd() {
  const cfg = vscode.workspace.getConfiguration('sftpFolderDiff');
  const order = ['fast', 'smart', 'content'] as const;
  const cur = cfg.get<typeof order[number]>('compareMode', 'smart');
  const next = order[(order.indexOf(cur) + 1) % order.length];
  await cfg.update('compareMode', next, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Compare mode: ${next}`);
}

async function clearPasswordCmd() {
  await registry.clearAll();
  vscode.window.showInformationMessage('Session passwords cleared; all connections disconnected.');
}

/* ---------- target-scoped commands (tree node inline / right-click) ---------- */

async function compareTargetCmd(node: DiffNode | { target: Target }) {
  const target = node instanceof DiffNode ? node.target : node?.target;
  if (!target) return;
  if (target.inFlight) {
    vscode.window.showInformationMessage(`${target.config.name}: compare already running.`);
    return;
  }
  await runCompare(target);
}

async function clearTargetDiffCmd(node: DiffNode) {
  if (!node?.target) return;
  registry.clearTargetDiff(node.target);
  treeProvider.refresh();
}

async function disconnectTargetCmd(node: DiffNode) {
  if (!node?.target) return;
  await registry.disconnectTarget(node.target);
  vscode.window.showInformationMessage(`${node.target.config.name}: disconnected.`);
}

/** Core compare loop: runs one target. */
async function runCompare(target: Target, subFolderAbs?: string) {
  target.inFlight = true;
  try {
    let conn: SftpService;
    try {
      conn = await registry.getOrConnectSftp(target);
    } catch (e: any) {
      vscode.window.showErrorMessage(`${target.config.name}: connect failed: ${e?.message || e}`);
      return;
    }

    let localBase = target.localBaseAbs;
    let remoteBase = target.config.remotePath;
    let scopeNote = '';

    if (subFolderAbs) {
      const abs = path.resolve(subFolderAbs);
      const rel = path.relative(target.localBaseAbs, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        vscode.window.showErrorMessage(`Selected folder is outside target "${target.config.name}".`);
        return;
      }
      if (rel) {
        localBase = abs;
        const posixRel = rel.replace(/\\/g, '/');
        remoteBase = remoteBase.endsWith('/') ? remoteBase + posixRel : remoteBase + '/' + posixRel;
        scopeNote = ` (scope: ${posixRel})`;
      }
    }

    const exclude = (target.config.exclude && target.config.exclude.length > 0)
      ? target.config.exclude
      : vscode.workspace.getConfiguration('sftpFolderDiff').get<string[]>('ignore', []);

    const mode = vscode.workspace
      .getConfiguration('sftpFolderDiff')
      .get<'fast' | 'smart' | 'content'>('compareMode', 'smart');

    let cancelled = false;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SFTP Diff · ${target.config.name}${scopeNote} · ${mode} mode`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: '🔌 Connecting...' });
        const engine = new DiffEngine(conn, target.key, localBase, remoteBase, exclude, mode);
        try {
          const result = await engine.run(
            (msg) => progress.report({ message: msg }),
            () => token.isCancellationRequested,
          );
          target.lastDiff = result;
          target.compared = true;
          treeProvider.refresh();
        } catch (e: any) {
          if (token.isCancellationRequested) {
            cancelled = true;
            return;
          }
          throw e;
        }
      }
    );

    if (cancelled) {
      vscode.window.showInformationMessage(`${target.config.name}${scopeNote}: cancelled. Previous results kept.`);
      return;
    }
    await vscode.commands.executeCommand('sftpFolderDiff.tree.focus');
    const summary = summarizeDiff(target.lastDiff);
    vscode.window.showInformationMessage(`${target.config.name}${scopeNote}: ${summary}`);
  } finally {
    target.inFlight = false;
  }
}

/* ---------- URI commands (right-click file/folder, editor menus, command palette w/ active editor) ---------- */

async function compareFolderCmd(uri?: vscode.Uri) {
  if (!uri) { vscode.window.showErrorMessage('No folder selected.'); return; }
  let stat;
  try { stat = fs.statSync(uri.fsPath); } catch { vscode.window.showErrorMessage('Path does not exist.'); return; }
  if (!stat.isDirectory()) { vscode.window.showErrorMessage('Please right-click a folder, not a file.'); return; }
  const target = targetForPath(uri.fsPath);
  if (!target) return;
  if (target.inFlight) {
    vscode.window.showInformationMessage(`${target.config.name}: compare already running.`);
    return;
  }
  await runCompare(target, uri.fsPath);
}

async function diffFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
    vscode.window.showErrorMessage('Not a file.');
    return;
  }
  const target = targetForPath(local);
  if (!target) return;
  const mapped = mapLocalToRemote(target, local);
  if (!mapped) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  const tmpRoot = path.join(require('os').tmpdir(), 'sftp-folder-diff', String(process.pid));
  const tmpPath = path.join(tmpRoot, 'remote', target.key, ...mapped.relPath.split('/'));
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

  try {
    await withTransferProgress(
      'Downloading for diff',
      path.basename(local),
      (step) => conn.download(mapped.remoteAbs, tmpPath, step)
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`Download for diff failed: ${e.message}`);
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(tmpPath),
    vscode.Uri.file(local),
    `${path.basename(local)}  (Remote ↔ Local · ${target.config.name})`,
    { preview: true }
  );
}

async function uploadFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
    vscode.window.showErrorMessage('Not a file.');
    return;
  }
  const target = targetForPath(local);
  if (!target) return;
  const mapped = mapLocalToRemote(target, local);
  if (!mapped) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    await withTransferProgress('Uploading', path.basename(local), (step) => conn.upload(local, mapped.remoteAbs, step));
    vscode.window.showInformationMessage(`Uploaded to ${target.config.name}: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Upload failed: ${e.message}`);
  }
}

async function downloadFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  if (fs.existsSync(local)) {
    if (!fs.statSync(local).isFile()) {
      vscode.window.showErrorMessage('Path is a directory, not a file.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Overwrite local file with remote?\n${local}`,
      { modal: true }, 'Overwrite'
    );
    if (ok !== 'Overwrite') return;
  }
  const target = targetForPath(local);
  if (!target) return;
  const mapped = mapLocalToRemote(target, local);
  if (!mapped) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await withTransferProgress('Downloading', path.basename(local), (step) => conn.download(mapped.remoteAbs, local, step));
    vscode.window.showInformationMessage(`Downloaded from ${target.config.name}: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Download failed: ${e.message}`);
  }
}

async function uploadFolderCmd(uri?: vscode.Uri) {
  if (!uri) { vscode.window.showErrorMessage('No folder selected.'); return; }
  const local = uri.fsPath;
  if (!fs.existsSync(local) || !fs.statSync(local).isDirectory()) {
    vscode.window.showErrorMessage('Not a folder.');
    return;
  }
  const target = targetForPath(local);
  if (!target) return;
  const mapped = mapLocalToRemote(target, local);
  if (!mapped) return;

  const ok = await vscode.window.showWarningMessage(
    `Upload folder to ${target.config.name}? This may overwrite files.\nLocal:  ${local}\nRemote: ${mapped.remoteAbs}`,
    { modal: true }, 'Upload'
  );
  if (ok !== 'Upload') return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    await withSpinnerProgress(`Uploading folder · ${target.config.name} · ${path.basename(local)}`, () => conn.uploadDir(local, mapped.remoteAbs));
    vscode.window.showInformationMessage(`Folder uploaded to ${target.config.name}: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Folder upload failed: ${e.message}`);
  }
}

async function downloadFolderCmd(uri?: vscode.Uri) {
  if (!uri) { vscode.window.showErrorMessage('No folder selected.'); return; }
  const local = uri.fsPath;
  if (fs.existsSync(local) && !fs.statSync(local).isDirectory()) {
    vscode.window.showErrorMessage('Not a folder.');
    return;
  }
  const target = targetForPath(local);
  if (!target) return;
  const mapped = mapLocalToRemote(target, local);
  if (!mapped) return;

  const ok = await vscode.window.showWarningMessage(
    `Download folder from ${target.config.name}? This may overwrite local files.\nRemote: ${mapped.remoteAbs}\nLocal:  ${local}`,
    { modal: true }, 'Download'
  );
  if (ok !== 'Download') return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    await withSpinnerProgress(`Downloading folder · ${target.config.name} · ${path.basename(local)}`, () => conn.downloadDir(mapped.remoteAbs, local));
    vscode.window.showInformationMessage(`Folder downloaded from ${target.config.name}: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Folder download failed: ${e.message}`);
  }
}

/* ---------- tree-node commands (act on a DiffNode that carries .entry) ---------- */

async function openDiffCmd(node: DiffNode) {
  if (!node?.entry) return;
  const entry = node.entry;
  const target = registry.get(entry.targetKey);
  if (!target) { vscode.window.showErrorMessage('Target gone.'); return; }

  if (entry.status === 'localOnly' && entry.localAbs) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localAbs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Open failed: ${e.message}`);
    }
    return;
  }

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  const tmpRoot = path.join(require('os').tmpdir(), 'sftp-folder-diff', String(process.pid));
  const tmpPath = path.join(tmpRoot, 'remote', target.key, ...entry.relPath.split('/'));
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

  try {
    const opLabel = entry.status === 'remoteOnly' ? 'Loading remote' : 'Loading remote (for diff)';
    await withTransferProgress(
      opLabel,
      path.basename(entry.relPath),
      (step) => conn.download(entry.remoteAbs!, tmpPath, step)
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`Download for diff failed: ${e.message}`);
    return;
  }

  if (entry.status === 'remoteOnly') {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
      await vscode.window.showTextDocument(doc, { preview: true });
      vscode.window.setStatusBarMessage(`Viewing remote-only (${target.config.name}): ${entry.relPath}`, 5000);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Open failed: ${e.message}`);
    }
    return;
  }

  const left = vscode.Uri.file(tmpPath);
  const right = vscode.Uri.file(entry.localAbs!);
  await vscode.commands.executeCommand(
    'vscode.diff', left, right,
    `${path.basename(entry.relPath)}  (Remote ↔ Local · ${target.config.name})`,
    { preview: true }
  );
}

async function uploadCmd(node: DiffNode) {
  if (!node?.entry) return;
  const target = registry.get(node.entry.targetKey);
  if (!target || !node.entry.localAbs) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    await withTransferProgress(
      'Uploading',
      path.basename(node.entry.relPath),
      (step) => conn.upload(node.entry!.localAbs!, node.entry!.remoteAbs!, step)
    );
    vscode.window.showInformationMessage(`Uploaded to ${target.config.name}: ${node.entry.relPath}`);
    removeEntryFromTarget(target, node.entry);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
  }
}

async function downloadCmd(node: DiffNode) {
  if (!node?.entry) return;
  const target = registry.get(node.entry.targetKey);
  if (!target || !node.entry.remoteAbs) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  try {
    fs.mkdirSync(path.dirname(node.entry.localAbs!), { recursive: true });
    await withTransferProgress(
      'Downloading',
      path.basename(node.entry.relPath),
      (step) => conn.download(node.entry!.remoteAbs!, node.entry!.localAbs!, step)
    );
    vscode.window.showInformationMessage(`Downloaded from ${target.config.name}: ${node.entry.relPath}`);
    removeEntryFromTarget(target, node.entry);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

async function deleteLocalCmd(node: DiffNode) {
  if (!node?.entry?.localAbs) return;
  const target = registry.get(node.entry.targetKey);
  if (!target) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete local file: ${node.entry.relPath}?`, { modal: true }, 'Delete'
  );
  if (ok !== 'Delete') return;
  fs.unlinkSync(node.entry.localAbs);
  removeEntryFromTarget(target, node.entry);
}

async function deleteRemoteCmd(node: DiffNode) {
  if (!node?.entry?.remoteAbs) return;
  const target = registry.get(node.entry.targetKey);
  if (!target) return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  const ok = await vscode.window.showWarningMessage(
    `Delete remote file from ${target.config.name}: ${node.entry.relPath}?`, { modal: true }, 'Delete'
  );
  if (ok !== 'Delete') return;
  try {
    await conn.deleteRemote(node.entry.remoteAbs);
    removeEntryFromTarget(target, node.entry);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Delete remote failed: ${e.message}`);
  }
}
```

- [ ] **Step 3: Update `package.json` `contributes.commands`**

Find the `contributes.commands` array. Remove these objects:

```json
{ "command": "sftpFolderDiff.compare",   "title": "SFTP Diff: Compare Folders Now", "icon": "$(refresh)" },
```

Add these three (anywhere in the array):

```json
{ "command": "sftpFolderDiff.compareTarget",    "title": "SFTP Diff: Compare This Target",     "icon": "$(refresh)" },
{ "command": "sftpFolderDiff.clearTargetDiff",  "title": "SFTP Diff: Clear Diff for This Target" },
{ "command": "sftpFolderDiff.disconnectTarget", "title": "SFTP Diff: Disconnect This Target" }
```

- [ ] **Step 4: Update `package.json` `contributes.menus`**

In `menus["view/title"]`, delete this entry:

```json
{ "command": "sftpFolderDiff.compare", "when": "view == sftpFolderDiff.tree", "group": "navigation@1" },
```

(The `toggleMode` entry stays.)

In `menus["view/item/context"]`, replace the existing array contents with:

```json
{ "command": "sftpFolderDiff.compareTarget",    "when": "view == sftpFolderDiff.tree && viewItem == targetRoot",                                "group": "inline@1" },
{ "command": "sftpFolderDiff.clearTargetDiff",  "when": "view == sftpFolderDiff.tree && viewItem == targetRoot",                                "group": "1_modification@1" },
{ "command": "sftpFolderDiff.disconnectTarget", "when": "view == sftpFolderDiff.tree && viewItem == targetRoot",                                "group": "1_modification@2" },
{ "command": "sftpFolderDiff.openDiff",         "when": "view == sftpFolderDiff.tree && viewItem =~ /modified|localOnly|remoteOnly/",           "group": "inline@1" },
{ "command": "sftpFolderDiff.upload",           "when": "view == sftpFolderDiff.tree && viewItem =~ /modified|localOnly/",                      "group": "inline@2" },
{ "command": "sftpFolderDiff.download",         "when": "view == sftpFolderDiff.tree && viewItem =~ /modified|remoteOnly/",                     "group": "inline@3" },
{ "command": "sftpFolderDiff.deleteLocal",      "when": "view == sftpFolderDiff.tree && viewItem == localOnly",                                 "group": "1_modification" },
{ "command": "sftpFolderDiff.deleteRemote",     "when": "view == sftpFolderDiff.tree && viewItem == remoteOnly",                                "group": "1_modification" }
```

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: clean exit.

- [ ] **Step 6: Manual smoke (REQUIRED — UI changes)**

Set up a test workspace with `.vscode/sftp-diff.json`:

```jsonc
[
  {
    "name": "api",
    "host": "<your-host>",
    "port": 22,
    "username": "<user>",
    "password": "",
    "privateKeyPath": "",
    "remotePath": "<reachable remote dir 1>",
    "localPath": "./api",
    "exclude": ["node_modules", ".git"]
  },
  {
    "name": "widget",
    "host": "<your-host>",
    "port": 22,
    "username": "<user>",
    "password": "",
    "privateKeyPath": "",
    "remotePath": "<reachable remote dir 2>",
    "localPath": "./widget",
    "exclude": ["node_modules", ".git"]
  }
]
```

Press **F5** to launch the Extension Development Host. Then verify:

1. Sidebar shows two target nodes (`api`, `widget`), both collapsed, with description `user@host:remote`. Both show `(not compared yet)` if expanded.
2. ↻ inline button on the `api` node runs a compare; tree auto-focuses; toast shows `api: N modified, M local-only, K remote-only`. `api` expands to the diff tree.
3. Same for `widget` — independent state.
4. Try right-clicking a file in `./api/` → `SFTP: Diff This File with Remote` works; download finishes; diff editor title contains `(Remote ↔ Local · api)`.
5. Right-clicking a folder in `./api/` → `Compare This Folder` scopes correctly.
6. Right-click a file in `./other/` (not under any target) → toast `not under any configured target`.
7. Edit `.vscode/sftp-diff.json` and add a third target (non-overlapping) — tree updates within a second (hot reload).
8. Edit it to introduce overlapping `localPath` (e.g. add a target with `localPath: "."`) — toast error, prior tree preserved.
9. Edit it to break JSON (delete a closing bracket) — toast error, prior tree preserved.
10. Right-click on a target node → `Clear Diff` / `Disconnect` work.
11. Run `SFTP Diff: Clear Session Password` from the palette — all targets disconnect.

If any of these fail, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: multi-target compare via TargetRegistry + grouped tree

extension.ts now delegates all per-target state to TargetRegistry; the
module-level sftp/lastDiff/sessionPassword globals are gone. Tree view
renders two levels: target roots (with inline ↻, right-click Clear Diff
/ Disconnect) and per-target file subtrees. All URI commands dispatch
through registry.findByLocalPath; all tree commands dispatch through
entry.targetKey. The global Compare Folders Now command and ↻ button
are removed — compares are per-target only. A config file watcher hot-
reloads .vscode/sftp-diff.json without requiring a window reload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs + version bump 0.8.0

**Files:**
- Modify: `package.json` (version)
- Modify: `package-lock.json` (synced via `npm install`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `USAGE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Bump `package.json` version**

Edit the `"version"` line:

```json
  "version": "0.8.0",
```

- [ ] **Step 2: Sync `package-lock.json`**

Run: `npm install`
Expected: lockfile updates the two `"version"` entries to `0.8.0`; no other diff.

- [ ] **Step 3: Prepend `CHANGELOG.md` 0.8.0 entry**

Insert this block immediately after the `[Keep a Changelog]` intro line:

```markdown
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
```

- [ ] **Step 4: Update `README.md`**

Find the Features list. Replace the existing `- **Two views**, sharing the same diff data` bullet and its sub-bullets with:

```markdown
- **Multi-target** — configure several SFTP servers + local↔remote mappings in one `.vscode/sftp-diff.json`; each target gets its own row in the sidebar and its own diff state
- **Per-target sidebar tree** — single source of truth, target nodes expand into nested folder/file diffs
```

Replace the existing `- **Inline actions** per file` and `- **Right-click anywhere**` bullets with:

```markdown
- **Inline actions** per target (↻ recompare) and per file (Diff / Upload / Download / Delete)
- **Right-click anywhere** for single-file or folder operations; the target is auto-resolved from the path
  - File: Diff with Remote / Upload / Download
  - Folder: Compare / Upload Folder / Download Folder
  - Editor tab and editor area menus too
```

In the Commands section, replace the existing table with:

```markdown
| Command | What it does |
|---|---|
| `SFTP Diff: Configure Connection` | Create/open `.vscode/sftp-diff.json` |
| `SFTP Diff: Compare This Target` | (Per-target ↻ in sidebar) compare one target's whole tree |
| `SFTP Diff: Compare This Folder` | (Right-click) scope a compare to a subfolder; auto-resolves the target |
| `SFTP Diff: Toggle Compare Mode` | Cycle through fast → smart → content |
| `SFTP Diff: Clear Session Password` | Wipe in-memory passwords, disconnect all targets |
| `SFTP: Diff This File with Remote` | (Right-click file or editor) |
| `SFTP: Upload This File to Remote` | Same |
| `SFTP: Download This File from Remote` | Same |
| `SFTP: Upload This Folder to Remote` | (Right-click folder) |
| `SFTP: Download This Folder from Remote` | Same |
```

Replace the existing Configuration snippet with:

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

Replace any `sftp-folder-diff-0.7.1.vsix` mentions with `sftp-folder-diff-0.8.0.vsix`.

- [ ] **Step 5: Update `USAGE.md`**

The config snippet at section "二、配置 / 2. Configuration" — replace with the array form (bilingual block, same fields):

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
    "exclude": ["node_modules", ".git", ".vscode", "dist", "out"]
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

Add a new field row "name" (required, unique) at the top of the field reference table. Add a note immediately under the table:

```markdown
> **多 target / Multi-target:** 文件顶层是 JSON 数组,每个对象一组完整配置。`name` 必填且全局唯一,`localPath` 在不同 target 间不能相互包含 (`./api` 与 `./api/sub` 不允许同存)。
>
> **Multi-target:** the file is a top-level JSON array; each element is an independent target. `name` is required and globally unique; `localPath` values must not be ancestors of one another (e.g. `./api` and `./api/sub` cannot coexist).
```

Delete the entire "## 七、两种视图 / 7. Two Views" section (the WebView paragraph) — the tree is the only view now. Renumber subsequent sections.

In "六、开始比较 / 6. Running a Compare", replace the "触发方式 / How to trigger" table with:

```markdown
| 入口 / Entry point | 比较范围 / Scope |
|---|---|
| 侧边栏 target 行的 ↻ 按钮 / ↻ button on a target row | 该 target 的 `localPath` ↔ `remotePath` |
| 资源管理器右键文件夹 → `Compare This Folder` / Explorer right-click folder | 自动匹配到该路径所属 target 的子树 / Auto-matched to the owning target |
```

In "九、命令清单 / 9. Command List", replace any `Compare Folders Now` row with the per-target equivalents:

```markdown
| `SFTP Diff: Compare This Target` | 侧边栏 ↻ 按钮触发,比较单个 target / Per-target ↻ in sidebar |
| `SFTP Diff: Clear Diff for This Target` | 右键 target 行,清掉差异列表 / Right-click target row, clear its diff list |
| `SFTP Diff: Disconnect This Target` | 右键 target 行,断开 SFTP / Right-click target row, disconnect SFTP |
```

- [ ] **Step 6: Update `CLAUDE.md`**

Replace the "Architecture" section's first bullet point (single source of truth) with:

```markdown
**Per-target state via `TargetRegistry`**: `extension.ts` owns one `TargetRegistry` instance that holds every target's `sftp`, `lastDiff`, `compared` flag, and `inFlight` flag. There are no module-level globals. The tree view and command handlers all go through the registry: `registry.findByLocalPath(absPath)` for URI commands, `registry.get(entry.targetKey)` for tree commands. After any mutation that changes `lastDiff` (upload/download/delete success), the handler calls `treeProvider.refresh()` to redraw.

**`DiffEntry` is the universal currency** (see `diffEngine.ts`). Required field `targetKey` lets every entry resolve back to its owning target. Three statuses (`localOnly | remoteOnly | modified`) drive icons, badges, and `viewItem` regex matching in `package.json`'s `view/item/context`. Target root nodes use `viewItem == targetRoot`, file nodes use the status string.

**Config is an array** (`.vscode/sftp-diff.json`). Validation runs once on load: required fields, unique `name`, and non-overlapping `localPath` (any pair where one is an ancestor of the other is rejected). Validation failure rejects the whole config — partial loads are not allowed. A `vscode.workspace.createFileSystemWatcher` triggers `registry.load()` on changes, preserving prior state if the new config is malformed.
```

Delete the "Single source of truth" paragraph and the WebView trampoline paragraph (they're stale). Update the "Compare mode toggle" paragraph: `lastDiff` reference becomes `target.lastDiff`; remove all WebView references throughout the file. The "Known gap" paragraph stays.

- [ ] **Step 7: Compile (defense-in-depth)**

Run: `npm run compile`
Expected: clean exit. (Docs don't affect compilation but a doc edit shouldn't accidentally touch `.ts` — this catches any slip.)

- [ ] **Step 8: Commit**

```bash
git add CHANGELOG.md README.md USAGE.md CLAUDE.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: bump to 0.8.0 + docs for multi-target

CHANGELOG 0.8.0 entry with explicit breaking-change list and a copy-
paste migration snippet. README/USAGE updated to the array config
form, three-mode compare table, per-target sidebar walk-through; the
WebView section is removed. CLAUDE.md architecture rewritten to
describe TargetRegistry and the multi-target data flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Release v0.8.0

**Files:** none (git/CI only)

- [ ] **Step 1: Final compile + working-tree status**

Run: `npm run compile && git status`
Expected: compile clean, working tree clean. If anything's uncommitted, stop and resolve before tagging.

- [ ] **Step 2: Push main**

```bash
git push origin main
```

- [ ] **Step 3: Tag and push tag**

```bash
git tag v0.8.0
git push origin v0.8.0
```

This triggers `.github/workflows/release.yml`, which packages the `.vsix` and attaches it to a new GitHub Release.

- [ ] **Step 4: Confirm CI**

```bash
gh run list --workflow=release.yml -L 2
```

Expected: a fresh run for `v0.8.0` in `queued` or `in_progress` state. Use `gh run watch <id>` if you want to block on completion. CI completion in 50-60 s, similar to prior releases.

- [ ] **Step 5: (Optional) Verify the released artifact**

Once CI completes:

```bash
gh release view v0.8.0
```

Expected: `sftp-folder-diff-0.8.0.vsix` listed. Install locally to spot-check:

```bash
gh release download v0.8.0 -p '*.vsix' --dir /tmp
code --install-extension /tmp/sftp-folder-diff-0.8.0.vsix
```

VSCode → Developer: Reload Window → confirm extension version is `0.8.0` (Extensions panel → SFTP Folder Diff → details).

---

## Self-Review Notes

### Spec coverage

| Spec section | Implementing task(s) |
|---|---|
| §1 Schema + validation | Task 1 (full validation logic in `TargetRegistry.load`) |
| §1 No backward compat | Task 1 (`Array.isArray` rejects single-object) |
| §2 `Target` interface + `TargetRegistry` class | Task 1 |
| §2 Password cache (`host:port:user`) | Task 1 (`getOrConnectSftp`) |
| §2 Hot reload + reconciliation | Task 4 (watcher in `activate`) + Task 1 (`load` reconciliation) |
| §2 `lastDiff` per target | Tasks 1, 2, 4 (registry, `targetKey` field, handler refactor) |
| §3 URI dispatch via `findByLocalPath` | Task 4 (URI command handlers) |
| §3 Tree dispatch via `entry.targetKey` | Task 4 (tree command handlers) |
| §3 New `compareTarget` / `clearTargetDiff` / `disconnectTarget` | Task 4 (handler code + package.json) |
| §3 Deleted `compare` global + `showTable` | Tasks 3, 4 |
| §4 Two-level tree | Task 4 (`treeView.ts` rewrite) |
| §4 Auto-focus on success | Task 4 (`runCompare` end) |
| §4 Empty-state placeholder | Task 4 (`view.message` in activate) |
| §5 InFlight debounce | Task 4 (`compareTargetCmd` and `runCompare`) |
| §5 Per-target connection isolation | Task 1 + Task 4 (no shared `sftp`) |
| §5 SFTP idle reconnect (already in 0.7.0) | Unchanged |
| §6 WebView deletion | Task 3 |
| §6 Migration guide | Task 5 (CHANGELOG) |
| §6 Version 0.8.0 | Task 5 |

### Placeholder scan

No "TBD" / "TODO" / "implement later" / "add appropriate error handling" / "write tests for the above" present. Every step has either complete code or an exact command + expected outcome.

### Type / name consistency

- `Target` defined once in Task 1, referenced consistently in Tasks 2-4 (`target.key`, `target.config`, `target.localBaseAbs`, `target.sftp`, `target.lastDiff`, `target.compared`, `target.inFlight`).
- `TargetRegistry` methods used in Task 4 match Task 1 declarations: `load`, `list`, `get`, `findByLocalPath`, `getOrConnectSftp`, `removeDiff`, `clearTargetDiff`, `disconnectTarget`, `clearAll`.
- `DiffEntry.targetKey` declared in Task 2, read in Task 4 (`registry.get(entry.targetKey)`).
- `DiffEngine` constructor signature `(sftp, targetKey, localBase, remoteBase, ignore, mode)` — Task 2 introduces the second arg, Task 4 uses the exact same order at the call site.
- `DiffNode` constructor signature `(label, collapsibleState, entry?, target?, children?)` — Task 4 `treeView.ts` defines, Task 4 `extension.ts` only reads `node.entry` and `node.target`, never constructs.
- `treeProvider.setTargets(...)` (Task 4 `treeView.ts`) and `treeProvider.refresh()` (no-arg) match call sites in `extension.ts` (Task 4).

### Scope check

Six tasks, all single-PR-able as one feature branch. No multi-subsystem decomposition needed. Each task ends at a clean compile point, so a partial completion (e.g. only Tasks 1-3) leaves the project in a coherent shippable-as-0.7.x state.
