# 发布到 GitHub 操作步骤

本指南是给仓库主人(你)的 —— 把这份代码推上 GitHub 并发布第一个 release。预计耗时 3-5 分钟。

## 一次性准备

### 1. 安装 git(如果还没装)

```bash
git --version    # 测试一下
```

没装就去 https://git-scm.com/downloads 装一个。

### 2. 在 GitHub 上建一个空仓库

1. 登录 https://github.com
2. 右上角 **+** → **New repository**
3. 填:
   - **Repository name**:`sftp-folder-diff`(或你喜欢的名字)
   - **Description**:`A VSCode extension for comparing local and remote SFTP folders.`
   - **Public**(开源)或 **Private**(私有)随你
   - ⚠️ **不要勾** "Initialize this repository with a README/.gitignore/license" —— 我们已经在本地准备好了,勾了会冲突
4. 点 **Create repository**

新仓库页面会给你一段 "…or push an existing repository from the command line" 的命令,记一下两条:
- 那个 `git remote add origin https://github.com/<你的用户名>/sftp-folder-diff.git`
- 以及 `git branch -M main` 和 `git push -u origin main`

## 推送代码

进入解压后的源码目录,**第一次推送**:

```bash
cd sftp-folder-diff           # 进入项目目录

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

推完后刷新 GitHub 仓库页,源码应该都在了。

## 第一次发布 release (v0.6.0)

有两条路:

### 路线 A:让 GitHub Actions 自动打包并发布(推荐)

代码里有 `.github/workflows/release.yml`,**只要打 git tag 就自动触发**:

```bash
git tag v0.6.0
git push origin v0.6.0
```

然后:
1. 到 GitHub 仓库页 → **Actions** 选项卡 → 看到 "Build & Release VSIX" 工作流在跑
2. 跑完(2-3 分钟)→ 仓库主页右侧的 **Releases** 区会出现 `v0.6.0`,vsix 文件已经挂上了
3. 别人就可以从 Releases 页直接下载

之后想发新版本(比如改了代码到 0.7.0):
```bash
# 改完代码后
git add . && git commit -m "feat: ..."
git push

# 改 package.json 里的 version 字段为 0.7.0,然后:
git add package.json && git commit -m "bump to 0.7.0"
git push
git tag v0.7.0
git push origin v0.7.0
# Actions 又会自动构建并发新 release
```

### 路线 B:手动上传 vsix

如果你不想用 GitHub Actions(比如仓库是 private 或没有 Actions 配额):

1. 仓库页 → 右侧 **Releases** → **Create a new release**
2. **Choose a tag** → 输入 `v0.6.0` → 点 "Create new tag: v0.6.0 on publish"
3. **Release title**:`v0.6.0`
4. **Describe this release**:复制 `CHANGELOG.md` 里 0.6.0 那一段
5. **Attach binaries**:把已经打好的 `sftp-folder-diff-0.6.0.vsix` 拖进去
6. 点 **Publish release**

## .gitignore 在保护什么

仓库里的 `.gitignore` 会拦掉:
- `node_modules/` — 别人 clone 后 `npm install` 自己生成,不该上传(几百 MB)
- `out/` — TypeScript 编译输出,自动生成
- `*.vsix` — 打包产物,本地用没必要上传(但 release 会附带)
- `.vscode-test/` — 测试缓存

⚠️ **`.vscode/sftp-diff.json` 不在 .gitignore 里** —— 这文件正常情况下不应该出现在仓库根(它是用户在自己 workspace 下生成的),但**如果你测试过用本仓库直接连过 SFTP,要确认密码没被提交进去**:

```bash
git ls-files | grep sftp-diff.json
```

输出为空就 OK。要是不幸提交了密码,赶紧改 GitHub 仓库为 private,改密码,然后 `git rm` 删掉那个文件再 push。

## 给 README 加徽章(可选美化)

推完后,把 `README.md` 里这两行徽章替换成真实数据:

```markdown
![status](https://img.shields.io/badge/status-beta-orange) ![license](https://img.shields.io/badge/license-MIT-blue)
```

可以加更多,比如:
- 最新 release 版本号:`![release](https://img.shields.io/github/v/release/<user>/sftp-folder-diff)`
- Stars:`![stars](https://img.shields.io/github/stars/<user>/sftp-folder-diff)`

## 想发到 VSCode 扩展市场?

不是 GitHub 范畴了,但顺手提一下流程,**你不是非做不可**:

1. 在 https://dev.azure.com 注册一个组织
2. 创建一个 publisher(https://marketplace.visualstudio.com/manage)
3. 把 `package.json` 里的 `publisher` 字段从 `local-dev` 改成你的 publisher ID
4. 加图标(`icon` 字段)、仓库链接(`repository` 字段)
5. 跑 `vsce login <publisher>` 然后 `vsce publish`

发了之后所有人都能在 VSCode 扩展面板里搜到。

## 常见问题

**Q: push 时报 "remote: Permission to ... denied"**
A: 用的是 https 但 token 没权限,或 token 过期。重新生成一个带 `repo` scope 的 PAT。

**Q: Actions 失败 "npm run compile" 报错**
A: 本地能编译但 Actions 不行,通常是 `package-lock.json` 缺。本地 `npm install` 一次,把 `package-lock.json` 一起 commit。

**Q: tag 打错了想撤回**
```bash
git tag -d v0.6.0                  # 删本地
git push origin :refs/tags/v0.6.0  # 删远端
```
对应 release 在 GitHub 网页上手动删。

**Q: GitHub Release 上传的 vsix 别人怎么装?**
A: 下载后:
```bash
code --install-extension sftp-folder-diff-0.6.0.vsix
```
或 VSCode 扩展面板 → ⋯ → Install from VSIX。
