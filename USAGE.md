# SFTP Folder Diff v0.3.0 — 安装和使用说明

## 包含

- `sftp-folder-diff-0.3.0.vsix` —— 可直接安装的插件包(已含所有依赖)
- `sftp-folder-diff-source.zip` —— 完整源码

## v0.3.0 新增

- **`exclude` 配置** 支持 glob 模式(`*.log`、`**/temp/*` 等),可写在 `.vscode/sftp-diff.json` 里(优先)或 VSCode 设置 `sftpFolderDiff.ignore`(后备)
- **临时密码** 配置文件里没填 `password` 也没 `privateKeyPath` 时,比较时弹输入框,**只保存在内存里**,VSCode 关闭即失效,绝不写盘
- **右键比较子目录** 资源管理器里任意文件夹上右键 → **SFTP Diff: Compare This Folder**,只比较那一个子树

---

## 一、安装

### 图形界面

VSCode 扩展面板(`Ctrl+Shift+X` / `Cmd+Shift+X`) → 右上角 `...` → **从 VSIX 安装...** → 选 `sftp-folder-diff-0.3.0.vsix`。

### 命令行

```bash
code --install-extension sftp-folder-diff-0.3.0.vsix
```

### 升级覆盖

如果之前装过 0.1.0,直接装新 vsix 即可,VSCode 会自动覆盖更新。

---

## 二、配置

打开本地项目 → 命令面板(`Ctrl+Shift+P`)→ **SFTP Diff: Configure Connection** → 编辑生成的 `.vscode/sftp-diff.json`:

```jsonc
{
  "host": "example.com",
  "port": 22,
  "username": "user",
  "password": "",                  // 留空或删掉 → 比较时会弹输入框
  "privateKeyPath": "",            // 想用私钥就填路径,会优先于密码
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

### 字段一览

| 字段 | 必填 | 说明 |
|---|---|---|
| `host` | ✅ | SFTP 服务器地址 |
| `port` | | 默认 22 |
| `username` | ✅ | 登录用户名 |
| `password` | | **空着即可** — 比较时会弹输入框,本次 VSCode 会话内不再问 |
| `privateKeyPath` | | 私钥文件绝对路径,设了则优先于密码 |
| `remotePath` | ✅ | 远程根目录(绝对路径) |
| `localPath` | | 本地根目录,相对 workspace,默认 `.` |
| `exclude` | | 扫描时跳过的 glob 模式数组(下面专门讲) |

### 安全建议

- 想避免密码上盘 → **直接留空 `password`**,用临时输入模式
- 想长期保存 → 用 `privateKeyPath` 私钥登录
- 实在要写明文密码 → 把 `.vscode/sftp-diff.json` 加进 `.gitignore`

---

## 三、exclude 排除规则

`.vscode/sftp-diff.json` 里的 `exclude` 数组优先生效;没设的话,回落到 VSCode 设置 `sftpFolderDiff.ignore`(默认值已包含常用项)。

### 支持的语法

| 模式 | 含义 | 例子 |
|---|---|---|
| **裸名** (无 `/` 无 `*`) | 匹配任意层级的同名段(像 gitignore 的目录名) | `node_modules` 命中 `node_modules/x` 和 `src/node_modules/y` |
| `*` | 匹配除 `/` 外的任何字符 | `*.log` 命中顶层 `error.log`,**不**命中 `src/error.log` |
| `**` | 匹配任何字符(含 `/`) | `**/temp/*` 命中任意层级 `temp` 目录下的文件 |
| `?` | 单字符通配,除 `/` 外 | `file?.txt` 命中 `file1.txt` 不命中 `file10.txt` |
| **精确路径** | 完整路径匹配 | `build/cache` 只命中 `build/cache` 本身 |

### 常见写法

```jsonc
{
  "exclude": [
    "node_modules",            // 整个目录,任意层级
    ".git",
    "*.log",                   // 顶层 .log 文件
    "**/*.log",                // 任意层级 .log 文件
    "**/temp/*",               // 任意层级 temp 目录下的文件
    "src/**/dist",             // src 下任意路径的 dist 目录
    ".env.local"
  ]
}
```

### 全局/工作区设置(没 sftp-diff.json 的 exclude 字段时生效)

`Ctrl+,` 搜 `sftpFolderDiff.ignore`,或在 `settings.json` 写:

```jsonc
{
  "sftpFolderDiff.ignore": ["node_modules", ".git", "*.log"]
}
```

---

## 四、临时密码模式

配置里 `password` 留空(且没设 `privateKeyPath`)时:

1. 第一次执行比较(或上传/下载等需要连接的操作)→ 弹输入框,提示 `SFTP password for user@host`,输入字符隐藏
2. 输入后**仅保存在当前 VSCode 进程内存**,本次 session 里所有后续操作直接复用,不再提问
3. **关闭/重启 VSCode → 内存清零**,下次又会弹
4. 认证失败时,自动清掉内存里的密码,下次重输

### 想中途清掉密码?

命令面板 → **SFTP Diff: Clear Session Password**(也会顺便断开当前连接)。比如用了同事电脑临时调试,做完想抹掉。

⚠️ 临时密码**只在本 VSCode 进程内存里**,不会写文件、不写 SecretStorage、不写 keychain。

---

## 五、右键比较子目录

在 VSCode 左侧资源管理器,**右键任意子文件夹** → 菜单底部有 **SFTP Diff: Compare This Folder**。

举例:你的 workspace 是 `/home/me/myapp`,`remotePath` 是 `/var/www/app`,你右键了 `/home/me/myapp/src/components`。比较只会发生在:

- 本地:`/home/me/myapp/src/components`
- 远程:`/var/www/app/src/components`

通知里会带 `(scope: src/components)` 字样,方便确认范围。

### 注意

- 右键的目录必须在 `localPath` 范围内,否则报错
- 子目录比较的结果会**替换**当前差异列表(不是叠加)
- exclude 规则仍然生效,但模式里的相对路径是相对**右键的那个子目录**而不是 workspace 根目录

---

## 六、开始比较

### 触发方式

| 入口 | 比较范围 |
|---|---|
| 活动栏 diff 图标 → 标题栏 🔄 刷新 | 整个 `localPath` ↔ `remotePath` |
| 命令面板 → `SFTP Diff: Compare Folders Now` | 同上 |
| 资源管理器右键文件夹 → `Compare This Folder` | 仅该子目录 |

### 两种比较模式

切换:标题栏 ⚙️ 图标,或命令 `Toggle Compare Mode`,或设置 `sftpFolderDiff.compareMode`。

- **fast**(默认):按大小 + mtime,秒级,适合常规检查
- **content**:下载远程做 SHA-256,精确,慢,适合 mtime 不可靠的场景(部署后 mtime 全被重置)

### 状态标记

| 标记 | 含义 | 颜色 |
|---|---|---|
| `M` | 两边都有但不同 | 黄 |
| `L only` | 仅本地有 | 绿 |
| `R only` | 仅远程有 | 红 |

---

## 七、两种视图

**树形侧边栏视图**(默认):
- 按目录结构展开,类似 Git 资源管理器
- 点 `M` 文件 → 打开 VSCode 原生 diff 编辑器(左远程 / 右本地)
- 悬停时右侧出现内联图标:diff / ↑上传 / ↓下载 / 🗑删除

**WebView 表格视图**:
- 一张完整表格:状态 / 路径 / 远程 size+mtime / 本地 size+mtime / 操作按钮
- 顶部 `↻ Re-compare` 按钮 + 数量统计
- 右上角实时模糊过滤输入框

打开:树视图标题栏 📋 图标,或命令 `SFTP Diff: Show as Table`。两个视图共享数据,操作互相同步。

---

## 八、操作按钮

| 按钮 | 行为 | 适用状态 |
|---|---|---|
| **Diff** | 打开 VSCode 原生 diff 编辑器 | M |
| **↑ Upload** | 本地覆盖远程,缺父目录自动建 | M / L only |
| **↓ Download** | 远程覆盖本地,缺父目录自动建 | M / R only |
| **🗑 Delete Local** | 删本地(modal 二次确认) | L only |
| **🗑 Delete Remote** | 删远程(modal 二次确认) | R only |

---

## 九、命令清单

| 命令 | 作用 |
|---|---|
| `SFTP Diff: Configure Connection` | 创建/打开 `.vscode/sftp-diff.json` |
| `SFTP Diff: Compare Folders Now` | 比较整个 localPath ↔ remotePath |
| `SFTP Diff: Compare This Folder` | 比较右键选中的子目录(也可命令面板调用 — 但需 URI) |
| `SFTP Diff: Show as Table` | 打开 WebView 表格视图 |
| `SFTP Diff: Toggle Compare Mode (Fast/Content)` | 切换比较模式 |
| `SFTP Diff: Clear Session Password` | 清掉内存里的临时密码并断开连接 |

---

## 十、自定义配置

`Ctrl+,` 搜 `sftpFolderDiff`:

- **`sftpFolderDiff.compareMode`**:`fast` / `content`
- **`sftpFolderDiff.ignore`**:全局 exclude 规则(被 sftp-diff.json 的 `exclude` 覆盖)

---

## 十一、常见问题

**Q: 临时密码下,VSCode 重启后会问几次?**
A: 每次重启后第一次需要连接时问一次,之后整个 session 不再问。

**Q: exclude 改了之后要重启吗?**
A: 不用,下次执行比较时就生效。

**Q: 右键比较子目录,如果远程没有对应路径会怎样?**
A: 远程扫不到就是空列表,本地所有文件会显示成 `L only`。如果想反过来知道远程独有的,这就是预期行为。

**Q: 比较慢?**
A: 检查模式是不是 `content`(每个候选文件都要下载哈希)。改回 `fast` 模式;并把 `node_modules` 等大目录加进 `exclude`。

**Q: 文件 mtime 两边不一致但内容一样?**
A: fast 模式会判 modified。切到 content 模式。

**Q: 想撤销升级?**
A: VSCode 扩展面板 → 找到 SFTP Folder Diff → 齿轮 → 安装其他版本,选 0.1.0 的 vsix。

---

## 十二、改源码

```bash
unzip sftp-folder-diff-source.zip
cd sftp-folder-diff
npm install
npm run compile
```

F5 启动 Extension Development Host 调试。重新打包:

```bash
npm install -g @vscode/vsce
vsce package --allow-missing-repository
```

### 源码结构

```
src/
├── extension.ts      # 入口、命令处理、session 密码
├── sftpService.ts    # SFTP 连接(ssh2-sftp-client 封装)
├── diffEngine.ts     # 递归扫描 + 三路对比
├── globMatcher.ts    # exclude 用的极简 glob 匹配器(无依赖)
├── treeView.ts       # 侧边栏树形视图
└── webviewPanel.ts   # 主编辑区 WebView 表格视图
```

---

## 已知限制

- 不处理 symlinks
- 仅用 workspace 第一个文件夹
- 临时密码模式只活在内存里(故意为之,符合需求)
- 没有"全部上传/全部下载"批量按钮
- 没有文件监听自动比较
