# SFTP Folder Diff v0.3.0 — 安装和使用说明 / Install & Usage Guide

## 包含 / What's Included

- `sftp-folder-diff-0.3.0.vsix` —— 可直接安装的插件包(已含所有依赖)
  `sftp-folder-diff-0.3.0.vsix` — ready-to-install extension package (all deps bundled)
- `sftp-folder-diff-source.zip` —— 完整源码
  `sftp-folder-diff-source.zip` — full source code

## v0.3.0 新增 / What's New in v0.3.0

- **`exclude` 配置** 支持 glob 模式(`*.log`、`**/temp/*` 等),可写在 `.vscode/sftp-diff.json` 里(优先)或 VSCode 设置 `sftpFolderDiff.ignore`(后备)
  **`exclude` config** with glob support (`*.log`, `**/temp/*`, etc.), writable in `.vscode/sftp-diff.json` (priority) or the VSCode setting `sftpFolderDiff.ignore` (fallback)
- **临时密码** 配置文件里没填 `password` 也没 `privateKeyPath` 时,比较时弹输入框,**只保存在内存里**,VSCode 关闭即失效,绝不写盘
  **Temporary password** — when neither `password` nor `privateKeyPath` is set, you get an input prompt at compare time. **Held in memory only**, cleared when VSCode closes, never written to disk
- **右键比较子目录** 资源管理器里任意文件夹上右键 → **SFTP Diff: Compare This Folder**,只比较那一个子树
  **Right-click subfolder compare** — right-click any folder in Explorer → **SFTP Diff: Compare This Folder** to scope the diff to just that subtree

---

## 一、安装 / 1. Installation

### 图形界面 / GUI

VSCode 扩展面板(`Ctrl+Shift+X` / `Cmd+Shift+X`) → 右上角 `...` → **从 VSIX 安装...** → 选 `sftp-folder-diff-0.3.0.vsix`。

VSCode Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) → top-right `...` → **Install from VSIX...** → pick `sftp-folder-diff-0.3.0.vsix`.

### 命令行 / Command line

```bash
code --install-extension sftp-folder-diff-0.3.0.vsix
```

### 升级覆盖 / Upgrading

如果之前装过 0.1.0,直接装新 vsix 即可,VSCode 会自动覆盖更新。

If you had 0.1.0 installed, just install the new vsix — VSCode will replace it automatically.

---

## 二、配置 / 2. Configuration

打开本地项目 → 命令面板(`Ctrl+Shift+P`)→ **SFTP Diff: Configure Connection** → 编辑生成的 `.vscode/sftp-diff.json`:

Open your local project → Command Palette (`Ctrl+Shift+P`) → **SFTP Diff: Configure Connection** → edit the generated `.vscode/sftp-diff.json`:

```jsonc
{
  "host": "example.com",
  "port": 22,
  "username": "user",
  "password": "",                  // 留空或删掉 → 比较时会弹输入框 / leave empty or remove → prompted at compare time
  "privateKeyPath": "",            // 想用私钥就填路径,会优先于密码 / set this to use a private key (takes precedence over password)
  "remotePath": "/var/www/project",
  "localPath": ".",
  "exclude": [
    "node_modules",
    ".git",
    ".vscode",
    "dist",
    "out",
    ".DS_Store",
    "*.log",
    "**/temp/*"
  ]
}
```

### 字段一览 / Field Reference

| 字段 / Field | 必填 / Required | 说明 / Description |
|---|---|---|
| `host` | ✅ | SFTP 服务器地址 / SFTP server address |
| `port` | | 默认 22 / Default 22 |
| `username` | ✅ | 登录用户名 / Login username |
| `password` | | **空着即可** — 比较时会弹输入框,本次 VSCode 会话内不再问 / **Leave blank** — you'll be prompted at compare time, then not asked again this session |
| `privateKeyPath` | | 私钥文件绝对路径,设了则优先于密码 / Absolute path to private key; takes precedence over password if set |
| `remotePath` | ✅ | 远程根目录(绝对路径) / Remote root directory (absolute path) |
| `localPath` | | 本地根目录,相对 workspace,默认 `.` / Local root, relative to workspace, defaults to `.` |
| `exclude` | | 扫描时跳过的 glob 模式数组(下面专门讲) / Glob patterns to skip during scan (details below) |

### 安全建议 / Security Tips

- 想避免密码上盘 → **直接留空 `password`**,用临时输入模式
  To avoid persisting your password → **leave `password` blank** and use the temporary input mode
- 想长期保存 → 用 `privateKeyPath` 私钥登录
  For long-term storage → use `privateKeyPath` with a private key
- 实在要写明文密码 → 把 `.vscode/sftp-diff.json` 加进 `.gitignore`
  If you really must store a plaintext password → add `.vscode/sftp-diff.json` to your `.gitignore`

---

## 三、exclude 排除规则 / 3. Exclude Rules

`.vscode/sftp-diff.json` 里的 `exclude` 数组优先生效;没设的话,回落到 VSCode 设置 `sftpFolderDiff.ignore`(默认值已包含常用项)。

The `exclude` array in `.vscode/sftp-diff.json` takes priority; if absent, it falls back to the VSCode setting `sftpFolderDiff.ignore` (the default already covers common entries).

### 支持的语法 / Supported Syntax

| 模式 / Pattern | 含义 / Meaning | 例子 / Example |
|---|---|---|
| **裸名** (无 `/` 无 `*`) / **Bare name** (no `/` or `*`) | 匹配任意层级的同名段(像 gitignore 的目录名) / Matches a same-named segment at any depth (like gitignore directory names) | `node_modules` 命中 `node_modules/x` 和 `src/node_modules/y` / `node_modules` matches both `node_modules/x` and `src/node_modules/y` |
| `*` | 匹配除 `/` 外的任何字符 / Matches any char except `/` | `*.log` 命中顶层 `error.log`,**不**命中 `src/error.log` / `*.log` matches top-level `error.log` but **not** `src/error.log` |
| `**` | 匹配任何字符(含 `/`) / Matches any char (including `/`) | `**/temp/*` 命中任意层级 `temp` 目录下的文件 / `**/temp/*` matches files inside `temp` at any depth |
| `?` | 单字符通配,除 `/` 外 / Single-char wildcard, except `/` | `file?.txt` 命中 `file1.txt` 不命中 `file10.txt` / `file?.txt` matches `file1.txt` but not `file10.txt` |
| **精确路径** / **Exact path** | 完整路径匹配 / Full-path match | `build/cache` 只命中 `build/cache` 本身 / `build/cache` matches only `build/cache` itself |

### 常见写法 / Common Patterns

```jsonc
{
  "exclude": [
    "node_modules",            // 整个目录,任意层级 / whole directory, any depth
    ".git",
    "*.log",                   // 顶层 .log 文件 / top-level .log files
    "**/*.log",                // 任意层级 .log 文件 / .log files at any depth
    "**/temp/*",               // 任意层级 temp 目录下的文件 / files inside any temp dir
    "src/**/dist",             // src 下任意路径的 dist 目录 / any dist dir under src
    ".env.local"
  ]
}
```

### 全局/工作区设置(没 sftp-diff.json 的 exclude 字段时生效) / Global/Workspace Setting (used when sftp-diff.json has no `exclude`)

`Ctrl+,` 搜 `sftpFolderDiff.ignore`,或在 `settings.json` 写:

`Ctrl+,` and search `sftpFolderDiff.ignore`, or in `settings.json`:

```jsonc
{
  "sftpFolderDiff.ignore": ["node_modules", ".git", "*.log"]
}
```

---

## 四、临时密码模式 / 4. Temporary Password Mode

配置里 `password` 留空(且没设 `privateKeyPath`)时:

When `password` is blank (and `privateKeyPath` is unset):

1. 第一次执行比较(或上传/下载等需要连接的操作)→ 弹输入框,提示 `SFTP password for user@host`,输入字符隐藏
   On the first compare (or upload/download/any op needing a connection) → an input prompt appears titled `SFTP password for user@host`, with input masked
2. 输入后**仅保存在当前 VSCode 进程内存**,本次 session 里所有后续操作直接复用,不再提问
   The entered password is **kept only in the current VSCode process memory**, reused for the rest of the session without re-prompting
3. **关闭/重启 VSCode → 内存清零**,下次又会弹
   **Close/restart VSCode → memory cleared**, you'll be prompted again next time
4. 认证失败时,自动清掉内存里的密码,下次重输
   On auth failure, the in-memory password is wiped automatically, so the next try re-prompts

### 想中途清掉密码? / Want to clear the password mid-session?

命令面板 → **SFTP Diff: Clear Session Password**(也会顺便断开当前连接)。比如用了同事电脑临时调试,做完想抹掉。

Command Palette → **SFTP Diff: Clear Session Password** (also disconnects the current session). E.g. you borrowed a coworker's machine for a quick fix and want to wipe traces afterward.

⚠️ 临时密码**只在本 VSCode 进程内存里**,不会写文件、不写 SecretStorage、不写 keychain。

⚠️ The temporary password lives **only in the current VSCode process memory** — never written to disk, SecretStorage, or keychain.

---

## 五、右键比较子目录 / 5. Right-Click Subfolder Compare

在 VSCode 左侧资源管理器,**右键任意子文件夹** → 菜单底部有 **SFTP Diff: Compare This Folder**。

In the VSCode Explorer sidebar, **right-click any subfolder** → at the bottom of the menu you'll find **SFTP Diff: Compare This Folder**.

举例:你的 workspace 是 `/home/me/myapp`,`remotePath` 是 `/var/www/app`,你右键了 `/home/me/myapp/src/components`。比较只会发生在:

Example: your workspace is `/home/me/myapp`, `remotePath` is `/var/www/app`, and you right-click `/home/me/myapp/src/components`. The compare scope is:

- 本地 / Local: `/home/me/myapp/src/components`
- 远程 / Remote: `/var/www/app/src/components`

通知里会带 `(scope: src/components)` 字样,方便确认范围。

The notification includes `(scope: src/components)` so you can confirm the range.

### 注意 / Notes

- 右键的目录必须在 `localPath` 范围内,否则报错
  The right-clicked folder must lie within `localPath`, otherwise an error is shown
- 子目录比较的结果会**替换**当前差异列表(不是叠加)
  Subfolder compare results **replace** the current diff list (not append)
- exclude 规则仍然生效,但模式里的相对路径是相对**右键的那个子目录**而不是 workspace 根目录
  Exclude rules still apply, but relative paths in patterns are relative to **the right-clicked subfolder**, not the workspace root

---

## 六、开始比较 / 6. Running a Compare

### 触发方式 / How to trigger

| 入口 / Entry point | 比较范围 / Scope |
|---|---|
| 活动栏 diff 图标 → 标题栏 🔄 刷新 / Activity bar diff icon → title bar 🔄 refresh | 整个 `localPath` ↔ `remotePath` / Entire `localPath` ↔ `remotePath` |
| 命令面板 → `SFTP Diff: Compare Folders Now` / Command Palette → `SFTP Diff: Compare Folders Now` | 同上 / Same as above |
| 资源管理器右键文件夹 → `Compare This Folder` / Explorer right-click folder → `Compare This Folder` | 仅该子目录 / That subfolder only |

### 三种比较模式 / Three compare modes

切换:标题栏 ⚙️ 图标循环 `fast → smart → content → fast`,或命令 `Toggle Compare Mode`,或设置 `sftpFolderDiff.compareMode`。

Switch via: title bar ⚙️ icon (cycles `fast → smart → content → fast`), command `Toggle Compare Mode`, or setting `sftpFolderDiff.compareMode`.

- **fast**:仅按大小 + mtime,秒级,假如部署/checkout 重置了 mtime 会把内容一致的文件误判成 modified
  **fast**: size + mtime only, seconds-scale; will false-positive identical files as modified when deploys / checkouts reset mtime
- **smart**(默认,推荐):先按 size + mtime 判,size 不同直接 modified;size 同 + mtime 同直接判一致;只有 size 同但 mtime 漂时才下载 hash 验证。大部分文件走快路径,少数靠 hash 兜底
  **smart** (default, recommended): size + mtime first; size mismatch → modified instantly; size + mtime both agree → trusted as identical; only size-equal-but-mtime-drift files fall back to SHA-256. Fast path for the common case, hash safety net for the rest
- **content**:无论 mtime,size 一致就 hash 双方比对。最准,最慢
  **content**: regardless of mtime, hash both sides whenever sizes match. Most accurate, slowest

### 状态标记 / Status badges

| 标记 / Badge | 含义 / Meaning | 颜色 / Color |
|---|---|---|
| `M` | 两边都有但不同 / Exists on both sides but differs | 黄 / Yellow |
| `L only` | 仅本地有 / Local only | 绿 / Green |
| `R only` | 仅远程有 / Remote only | 红 / Red |

---

### 取消 / Cancelling

比较过程中,通知右上角的 ✕ 按钮可中断比较。已经比较出来的差异不会丢,但本次跑的新数据会被丢弃,列表保留上一次的结果。content 模式下取消会等当前文件 hash 完才停(单文件级粒度)。

While a compare is running, click the ✕ in the top-right corner of the progress notification to abort. The previous diff list is preserved (the in-flight scan is discarded). In `content` mode, cancellation waits for the current file's hash to finish before stopping (per-file granularity).

### 比较完自动跳转 / Auto-reveal on completion

比较成功完成后,SFTP Folder Diff 侧边栏会自动展开并聚焦到差异树,不用再手动点活动栏图标。取消或失败时不跳转,保留你当前的视图。

When a compare succeeds, the SFTP Folder Diff sidebar auto-focuses to the differences tree — no need to click the activity bar icon. Cancellation or errors do not change the focus, so your current view is preserved.

---

## 七、两种视图 / 7. Two Views

**树形侧边栏视图**(默认): / **Tree sidebar view** (default):
- 按目录结构展开,类似 Git 资源管理器
  Expands by directory structure, like the Git Source Control panel
- 点 `M` 文件 → 打开 VSCode 原生 diff 编辑器(左远程 / 右本地)
  Click an `M` file → opens VSCode's native diff editor (Remote on the left / Local on the right)
- 悬停时右侧出现内联图标:diff / ↑上传 / ↓下载 / 🗑删除
  On hover, inline icons appear on the right: diff / ↑ upload / ↓ download / 🗑 delete

**WebView 表格视图**: / **WebView table view**:
- 一张完整表格:状态 / 路径 / 远程 size+mtime / 本地 size+mtime / 操作按钮
  Full table: status / path / remote size+mtime / local size+mtime / action buttons
- 顶部 `↻ Re-compare` 按钮 + 数量统计
  Top `↻ Re-compare` button + count summary
- 右上角实时模糊过滤输入框
  Live fuzzy filter input in the top-right corner

打开:树视图标题栏 📋 图标,或命令 `SFTP Diff: Show as Table`。两个视图共享数据,操作互相同步。

To open: 📋 icon in the tree view title bar, or command `SFTP Diff: Show as Table`. The two views share data and stay in sync after every operation.

---

## 八、操作按钮 / 8. Action Buttons

| 按钮 / Button | 行为 / Action | 适用状态 / Applies to |
|---|---|---|
| **Diff** | 打开 VSCode 原生 diff 编辑器 / Opens VSCode's native diff editor | M |
| **↑ Upload** | 本地覆盖远程,缺父目录自动建 / Local overwrites remote; missing parent dirs are auto-created | M / L only |
| **↓ Download** | 远程覆盖本地,缺父目录自动建 / Remote overwrites local; missing parent dirs are auto-created | M / R only |
| **🗑 Delete Local** | 删本地(modal 二次确认) / Delete local (modal confirmation) | L only |
| **🗑 Delete Remote** | 删远程(modal 二次确认) / Delete remote (modal confirmation) | R only |

---

## 九、命令清单 / 9. Command List

| 命令 / Command | 作用 / What it does |
|---|---|
| `SFTP Diff: Configure Connection` | 创建/打开 `.vscode/sftp-diff.json` / Create/open `.vscode/sftp-diff.json` |
| `SFTP Diff: Compare Folders Now` | 比较整个 localPath ↔ remotePath / Compare the whole localPath ↔ remotePath |
| `SFTP Diff: Compare This Folder` | 比较右键选中的子目录(也可命令面板调用 — 但需 URI) / Compare a right-clicked subfolder (callable from Command Palette too — needs a URI) |
| `SFTP Diff: Show as Table` | 打开 WebView 表格视图 / Open the WebView table view |
| `SFTP Diff: Toggle Compare Mode (Fast/Smart/Content)` | 循环切换比较模式 / Cycle through compare modes |
| `SFTP Diff: Clear Session Password` | 清掉内存里的临时密码并断开连接 / Clear the in-memory temporary password and disconnect |

---

## 十、自定义配置 / 10. Custom Settings

`Ctrl+,` 搜 `sftpFolderDiff`:

`Ctrl+,` and search `sftpFolderDiff`:

- **`sftpFolderDiff.compareMode`**:`fast` / `smart` / `content`(默认 `smart` / default `smart`)
- **`sftpFolderDiff.ignore`**:全局 exclude 规则(被 sftp-diff.json 的 `exclude` 覆盖)
  **`sftpFolderDiff.ignore`**: global exclude rules (overridden by the `exclude` field in sftp-diff.json)

---

## 十一、常见问题 / 11. FAQ

**Q: 临时密码下,VSCode 重启后会问几次?**
**Q: With temporary passwords, how often does VSCode ask after a restart?**
A: 每次重启后第一次需要连接时问一次,之后整个 session 不再问。
A: Once on the first connection after each restart, then never again for the rest of that session.

**Q: exclude 改了之后要重启吗?**
**Q: Do I need to restart after changing `exclude`?**
A: 不用,下次执行比较时就生效。
A: No — it takes effect on the next compare.

**Q: 右键比较子目录,如果远程没有对应路径会怎样?**
**Q: What if the remote doesn't have the path I right-clicked?**
A: 远程扫不到就是空列表,本地所有文件会显示成 `L only`。如果想反过来知道远程独有的,这就是预期行为。
A: An empty remote scan means all local files show as `L only`. This is the expected behavior — it's also how you'd discover what's local-only.

**Q: 比较慢?**
**Q: Compare is slow?**
A: 检查模式是不是 `content`(每个候选文件都要下载哈希)。改回默认的 `smart` 模式(只在 mtime 漂时才 hash),或者用 `fast`(完全跳过 hash);并把 `node_modules` 等大目录加进 `exclude`。
A: Check whether mode is `content` (every candidate file gets downloaded and hashed). Switch back to the default `smart` (only hashes when mtime drifts) or use `fast` (skips hashing entirely), and add big directories like `node_modules` to `exclude`.

**Q: 文件 mtime 两边不一致但内容一样?**
**Q: A file has different mtimes on both sides but identical contents?**
A: fast 模式会判 modified。用默认的 smart 模式即可 —— 它会自动在 mtime 漂的时候 hash 验证。
A: `fast` mode will flag it as modified. Use the default `smart` mode — it auto-hashes when mtime drifts, so identical contents won't be flagged.

**Q: 想撤销升级?**
**Q: How do I roll back to a previous version?**
A: VSCode 扩展面板 → 找到 SFTP Folder Diff → 齿轮 → 安装其他版本,选 0.1.0 的 vsix。
A: VSCode Extensions panel → find SFTP Folder Diff → gear icon → Install Another Version → pick the 0.1.0 vsix.

---

## 十二、改源码 / 12. Modifying the Source

```bash
unzip sftp-folder-diff-source.zip
cd sftp-folder-diff
npm install
npm run compile
```

F5 启动 Extension Development Host 调试。重新打包:

Press F5 to launch an Extension Development Host for debugging. To repackage:

```bash
npm install -g @vscode/vsce
vsce package --allow-missing-repository
```

### 源码结构 / Source Layout

```
src/
├── extension.ts      # 入口、命令处理、session 密码 / entry point, command handlers, session password
├── sftpService.ts    # SFTP 连接(ssh2-sftp-client 封装) / SFTP connection (ssh2-sftp-client wrapper)
├── diffEngine.ts     # 递归扫描 + 三路对比 / recursive scan + 3-way comparison
├── globMatcher.ts    # exclude 用的极简 glob 匹配器(无依赖) / minimal glob matcher for `exclude` (zero deps)
├── treeView.ts       # 侧边栏树形视图 / sidebar tree view
└── webviewPanel.ts   # 主编辑区 WebView 表格视图 / main-editor-area WebView table view
```

---

## 已知限制 / Known Limitations

- 不处理 symlinks
  Symlinks are not handled
- 仅用 workspace 第一个文件夹
  Only the first workspace folder is used
- 临时密码模式只活在内存里(故意为之,符合需求)
  Temporary password mode is memory-only (intentional, matches the design goal)
- 没有"全部上传/全部下载"批量按钮
  No "upload all / download all" bulk buttons
- 没有文件监听自动比较
  No file watcher / auto-compare
