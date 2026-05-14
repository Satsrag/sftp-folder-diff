# 发布到 GitHub 操作步骤 / Publishing to GitHub — Step-by-Step

本指南是给仓库主人(你)的 —— 把这份代码推上 GitHub 并发布第一个 release。预计耗时 3-5 分钟。

This guide is for the repository owner (you) — push this code to GitHub and ship your first release. Estimated time: 3–5 minutes.

## 一次性准备 / One-Time Setup

### 1. 安装 git(如果还没装) / Install git (if you don't have it yet)

```bash
git --version    # 测试一下 / quick check
```

没装就去 https://git-scm.com/downloads 装一个。

If it's not installed, grab it from https://git-scm.com/downloads.

### 2. 在 GitHub 上建一个空仓库 / Create an empty repository on GitHub

1. 登录 https://github.com
   Sign in at https://github.com
2. 右上角 **+** → **New repository**
   Top-right **+** → **New repository**
3. 填:
   Fill in:
   - **Repository name**:`sftp-folder-diff`(或你喜欢的名字)
     **Repository name**: `sftp-folder-diff` (or whatever name you like)
   - **Description**:`A VSCode extension for comparing local and remote SFTP folders.`
     **Description**: `A VSCode extension for comparing local and remote SFTP folders.`
   - **Public**(开源)或 **Private**(私有)随你
     **Public** (open source) or **Private** — your call
   - ⚠️ **不要勾** "Initialize this repository with a README/.gitignore/license" —— 我们已经在本地准备好了,勾了会冲突
     ⚠️ **Do NOT check** "Initialize this repository with a README/.gitignore/license" — we already have these locally, and checking them will cause conflicts
4. 点 **Create repository**
   Click **Create repository**

新仓库页面会给你一段 "…or push an existing repository from the command line" 的命令,记一下两条:
- 那个 `git remote add origin https://github.com/<你的用户名>/sftp-folder-diff.git`
- 以及 `git branch -M main` 和 `git push -u origin main`

The new repo page will show a "…or push an existing repository from the command line" snippet. Note these lines:
- `git remote add origin https://github.com/<your-username>/sftp-folder-diff.git`
- plus `git branch -M main` and `git push -u origin main`

## 推送代码 / Push the Code

进入解压后的源码目录,**第一次推送**:

Enter the unzipped source directory. **First push**:

```bash
cd sftp-folder-diff           # 进入项目目录 / cd into the project

git init
git add .
git commit -m "Initial commit — v0.6.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/sftp-folder-diff.git
git push -u origin main
```

第一次会要求你登录。如果是用 HTTPS,GitHub 现在要求用 **Personal Access Token (PAT)** 作密码,不是网页密码:
- 去 https://github.com/settings/tokens → Generate new token (classic) → 至少勾 `repo` 权限 → 复制 token
- 终端弹出 password 时粘上去

You'll be asked to authenticate on the first push. Over HTTPS, GitHub now requires a **Personal Access Token (PAT)** as the password — not your website password:
- Go to https://github.com/settings/tokens → Generate new token (classic) → check at least the `repo` scope → copy the token
- Paste it when the terminal prompts for a password

推完后刷新 GitHub 仓库页,源码应该都在了。

After pushing, refresh the GitHub repo page — the source should all be there.

## 第一次发布 release (v0.6.0) / First Release (v0.6.0)

有两条路:

There are two paths:

### 路线 A:让 GitHub Actions 自动打包并发布(推荐) / Path A: Let GitHub Actions build and publish automatically (recommended)

代码里有 `.github/workflows/release.yml`,**只要打 git tag 就自动触发**:

The repo includes `.github/workflows/release.yml` — **just push a git tag and it auto-triggers**:

```bash
git tag v0.6.0
git push origin v0.6.0
```

然后:
1. 到 GitHub 仓库页 → **Actions** 选项卡 → 看到 "Build & Release VSIX" 工作流在跑
2. 跑完(2-3 分钟)→ 仓库主页右侧的 **Releases** 区会出现 `v0.6.0`,vsix 文件已经挂上了
3. 别人就可以从 Releases 页直接下载

Then:
1. Go to the repo page → **Actions** tab → you'll see the "Build & Release VSIX" workflow running
2. Once it finishes (2–3 minutes) → the **Releases** section on the right side of the repo home will show `v0.6.0`, with the vsix already attached
3. Anyone can now download it directly from the Releases page

之后想发新版本(比如改了代码到 0.7.0):

For future releases (say, bumping to 0.7.0):

```bash
# 改完代码后 / After your code changes
git add . && git commit -m "feat: ..."
git push

# 改 package.json 里的 version 字段为 0.7.0,然后:
# Bump the version field in package.json to 0.7.0, then:
git add package.json && git commit -m "bump to 0.7.0"
git push
git tag v0.7.0
git push origin v0.7.0
# Actions 又会自动构建并发新 release / Actions will auto-build and ship the new release
```

### 路线 B:手动上传 vsix / Path B: Upload the vsix manually

如果你不想用 GitHub Actions(比如仓库是 private 或没有 Actions 配额):

If you don't want to use GitHub Actions (e.g., the repo is private, or you're out of Actions quota):

1. 仓库页 → 右侧 **Releases** → **Create a new release**
   Repo page → **Releases** on the right → **Create a new release**
2. **Choose a tag** → 输入 `v0.6.0` → 点 "Create new tag: v0.6.0 on publish"
   **Choose a tag** → enter `v0.6.0` → click "Create new tag: v0.6.0 on publish"
3. **Release title**:`v0.6.0`
   **Release title**: `v0.6.0`
4. **Describe this release**:复制 `CHANGELOG.md` 里 0.6.0 那一段
   **Describe this release**: paste the 0.6.0 section from `CHANGELOG.md`
5. **Attach binaries**:把已经打好的 `sftp-folder-diff-0.6.0.vsix` 拖进去
   **Attach binaries**: drag in the prebuilt `sftp-folder-diff-0.6.0.vsix`
6. 点 **Publish release**
   Click **Publish release**

## .gitignore 在保护什么 / What .gitignore Protects

仓库里的 `.gitignore` 会拦掉:
- `node_modules/` — 别人 clone 后 `npm install` 自己生成,不该上传(几百 MB)
- `out/` — TypeScript 编译输出,自动生成
- `*.vsix` — 打包产物,本地用没必要上传(但 release 会附带)
- `.vscode-test/` — 测试缓存

The `.gitignore` in the repo excludes:
- `node_modules/` — others regenerate it via `npm install` after cloning; shouldn't be uploaded (hundreds of MB)
- `out/` — TypeScript compile output, auto-generated
- `*.vsix` — build artifacts, no need to upload for local use (but releases will attach them)
- `.vscode-test/` — test cache

⚠️ **`.vscode/sftp-diff.json` 不在 .gitignore 里** —— 这文件正常情况下不应该出现在仓库根(它是用户在自己 workspace 下生成的),但**如果你测试过用本仓库直接连过 SFTP,要确认密码没被提交进去**:

⚠️ **`.vscode/sftp-diff.json` is NOT in .gitignore** — this file normally shouldn't appear in the repo root (it's generated by the user inside their own workspace), but **if you've used this repo directly to test SFTP connections, double-check that no password got committed**:

```bash
git ls-files | grep sftp-diff.json
```

输出为空就 OK。要是不幸提交了密码,赶紧改 GitHub 仓库为 private,改密码,然后 `git rm` 删掉那个文件再 push。

Empty output means you're fine. If you accidentally committed a password, immediately switch the GitHub repo to private, change the password, then `git rm` the file and push again.

## 给 README 加徽章(可选美化) / Add Badges to the README (optional polish)

推完后,把 `README.md` 里这两行徽章替换成真实数据:

After pushing, replace these two badge lines in `README.md` with real data:

```markdown
![status](https://img.shields.io/badge/status-beta-orange) ![license](https://img.shields.io/badge/license-MIT-blue)
```

可以加更多,比如:
- 最新 release 版本号:`![release](https://img.shields.io/github/v/release/<user>/sftp-folder-diff)`
- Stars:`![stars](https://img.shields.io/github/stars/<user>/sftp-folder-diff)`

You can add more, such as:
- Latest release version: `![release](https://img.shields.io/github/v/release/<user>/sftp-folder-diff)`
- Stars: `![stars](https://img.shields.io/github/stars/<user>/sftp-folder-diff)`

## 想发到 VSCode 扩展市场? / Want to Publish to the VSCode Marketplace?

不是 GitHub 范畴了,但顺手提一下流程,**你不是非做不可**:

This is outside GitHub's scope, but here's the flow for completeness — **you don't have to do this**:

1. 在 https://dev.azure.com 注册一个组织
   Register an organization at https://dev.azure.com
2. 创建一个 publisher(https://marketplace.visualstudio.com/manage)
   Create a publisher (https://marketplace.visualstudio.com/manage)
3. 把 `package.json` 里的 `publisher` 字段从 `local-dev` 改成你的 publisher ID
   Change the `publisher` field in `package.json` from `local-dev` to your publisher ID
4. 加图标(`icon` 字段)、仓库链接(`repository` 字段)
   Add an icon (`icon` field) and repository link (`repository` field)
5. 跑 `vsce login <publisher>` 然后 `vsce publish`
   Run `vsce login <publisher>`, then `vsce publish`

发了之后所有人都能在 VSCode 扩展面板里搜到。

Once published, anyone can search for it in the VSCode Extensions panel.

## 常见问题 / FAQ

**Q: push 时报 "remote: Permission to ... denied"**
**Q: Push fails with "remote: Permission to ... denied"**
A: 用的是 https 但 token 没权限,或 token 过期。重新生成一个带 `repo` scope 的 PAT。
A: You're using HTTPS but the token lacks permissions, or the token has expired. Regenerate a PAT with the `repo` scope.

**Q: Actions 失败 "npm run compile" 报错**
**Q: Actions fails with an "npm run compile" error**
A: 本地能编译但 Actions 不行,通常是 `package-lock.json` 缺。本地 `npm install` 一次,把 `package-lock.json` 一起 commit。
A: Compiles locally but not on Actions — usually means `package-lock.json` is missing. Run `npm install` locally once, then commit `package-lock.json` along with the rest.

**Q: tag 打错了想撤回**
**Q: Pushed the wrong tag and want to undo it**
```bash
git tag -d v0.6.0                  # 删本地 / delete locally
git push origin :refs/tags/v0.6.0  # 删远端 / delete on remote
```
对应 release 在 GitHub 网页上手动删。

Manually delete the corresponding release on the GitHub web UI.

**Q: GitHub Release 上传的 vsix 别人怎么装?**
**Q: How do others install the vsix uploaded to a GitHub Release?**
A: 下载后:
A: After downloading:
```bash
code --install-extension sftp-folder-diff-0.6.0.vsix
```
或 VSCode 扩展面板 → ⋯ → Install from VSIX。

Or via the VSCode Extensions panel → ⋯ → Install from VSIX.
