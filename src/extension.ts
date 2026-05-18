import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpService, SftpConfig, DirTransferResult } from './sftpService';
import { DiffEngine, DiffEntry } from './diffEngine';
import { DiffTreeProvider, DiffNode } from './treeView';
import { TargetRegistry, Target } from './targetRegistry';
import { GlobMatcher } from './globMatcher';

const CONFIG_FILE = '.vscode/sftp-diff.json';

let treeProvider: DiffTreeProvider;
let registry: TargetRegistry;
let watcher: vscode.FileSystemWatcher | undefined;

/* ---------- progress helpers ---------- */

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return s.slice(0, left) + '…' + s.slice(s.length - right);
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
    const doReload = () => {
      const r = registry.load();
      if (!r.ok) {
        vscode.window.showErrorMessage(`SFTP Diff config error: ${r.errors[0]}`);
      }
      treeProvider.setTargets(registry.list());
      view.message = registry.list().length === 0
        ? 'No targets configured. Run SFTP Diff: Configure Connection.'
        : undefined;
    };
    let reloadTimer: NodeJS.Timeout | undefined;
    const reload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(doReload, 300);
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

/** Make a string safe to use as a single path segment (no separators, no traversal). */
function safeSegment(s: string): string {
  return s.replace(/[\\/]/g, '_').replace(/\.\./g, '_');
}

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
    try {
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
    } catch (e: any) {
      vscode.window.showErrorMessage(`${target.config.name}${scopeNote}: compare failed: ${e?.message || e}`);
      return;
    }

    if (cancelled) {
      vscode.window.showInformationMessage(`${target.config.name}${scopeNote}: cancelled. Previous results kept.`);
      return;
    }
    try { await vscode.commands.executeCommand('sftpFolderDiff.tree.focus'); } catch { /* ignore */ }
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
  const safeKey = safeSegment(target.key);
  const segs = mapped.relPath.split('/').map(safeSegment);
  const tmpPath = path.join(tmpRoot, 'remote', safeKey, ...segs);
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

/**
 * Resolve the effective exclude matcher for a folder transfer.
 * Same precedence as compare: cfg.exclude wins if non-empty,
 * otherwise fall back to the workspace setting.
 */
function buildExcludeMatcher(target: Target): GlobMatcher {
  const patterns = (target.config.exclude && target.config.exclude.length > 0)
    ? target.config.exclude
    : vscode.workspace.getConfiguration('sftpFolderDiff').get<string[]>('ignore', []);
  return new GlobMatcher(patterns);
}

/**
 * Run a directory transfer (upload OR download) with a cancellable progress
 * notification. Both folder commands share this since the UX is identical:
 * "N/M files · X / Y · pct% · current/rel/path".
 */
async function runDirTransfer(opts: {
  conn: SftpService;
  title: string;
  exclude: GlobMatcher;
  work: (cb: { progress: (p: any) => void; cancelled: () => boolean }) => Promise<DirTransferResult>;
}): Promise<DirTransferResult | undefined> {
  let result: DirTransferResult | undefined;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: opts.title,
        cancellable: true,
      },
      async (progress, token) => {
        let lastTick = Date.now();
        result = await opts.work({
          progress: (p) => {
            const now = Date.now();
            // throttle to ~80 ms unless we're at the very end
            if (now - lastTick < 80 && p.filesDone < p.filesTotal) return;
            lastTick = now;
            const pct = p.bytesTotal > 0 ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 0;
            const fileLine = p.currentFile ? ` · ${truncMid(p.currentFile, 50)}` : '';
            progress.report({
              message: `${p.filesDone}/${p.filesTotal} files · ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)} · ${pct}%${fileLine}`,
            });
          },
          cancelled: () => token.isCancellationRequested,
        });
      }
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`${opts.title}: ${e?.message || e}`);
    return undefined;
  }
  return result;
}

/**
 * Format the final summary toast for a folder transfer. Combines counts,
 * bytes, cancellation state, and failure info into one message.
 */
function summarizeDirResult(verb: string, targetName: string, scope: string, r: DirTransferResult): { kind: 'info' | 'warn'; text: string } {
  const totalAttempted = r.filesTransferred + r.filesFailed;
  if (r.cancelled) {
    return {
      kind: 'warn',
      text: `${targetName}: ${verb} cancelled at ${r.filesTransferred}/${totalAttempted} files (${fmtBytes(r.bytesTransferred)}).${r.filesFailed ? ` ${r.filesFailed} failed.` : ''}`,
    };
  }
  if (r.filesFailed > 0) {
    const first = r.errors[0];
    return {
      kind: 'warn',
      text: `${targetName}${scope}: ${r.filesTransferred} ${verb}, ${r.filesFailed} failed (${fmtBytes(r.bytesTransferred)}). First error: ${first.relPath}: ${first.error}`,
    };
  }
  return {
    kind: 'info',
    text: `${targetName}${scope}: ${verb} ${r.filesTransferred} files (${fmtBytes(r.bytesTransferred)}).`,
  };
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
    `Upload folder to ${target.config.name}? This may overwrite files. exclude rules will be honored.\nLocal:  ${local}\nRemote: ${mapped.remoteAbs}`,
    { modal: true }, 'Upload'
  );
  if (ok !== 'Upload') return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  const matcher = buildExcludeMatcher(target);
  // Exclude paths are scoped to the folder being uploaded — match relPath against the
  // matcher built from full target exclude patterns. The matcher handles bare-name
  // (any segment) + glob; works whether we pass "node_modules/foo/bar" or "foo/bar"
  // because bare-name segments match anywhere.

  const result = await runDirTransfer({
    conn,
    title: `Uploading folder · ${target.config.name} · ${path.basename(local)}`,
    exclude: matcher,
    work: ({ progress, cancelled }) => conn.uploadDir(local, mapped.remoteAbs, {
      exclude: (rel) => matcher.ignores(rel),
      progress,
      cancelled,
    }),
  });
  if (!result) return;

  const scopeNote = mapped.relPath ? ` (${mapped.relPath})` : '';
  const s = summarizeDirResult('uploaded', target.config.name, scopeNote, result);
  if (s.kind === 'warn') vscode.window.showWarningMessage(s.text);
  else vscode.window.showInformationMessage(s.text);
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
    `Download folder from ${target.config.name}? This may overwrite local files. exclude rules will be honored.\nRemote: ${mapped.remoteAbs}\nLocal:  ${local}`,
    { modal: true }, 'Download'
  );
  if (ok !== 'Download') return;

  let conn: SftpService;
  try { conn = await registry.getOrConnectSftp(target); }
  catch (e: any) { vscode.window.showErrorMessage(`${target.config.name}: ${e?.message || e}`); return; }

  const matcher = buildExcludeMatcher(target);

  const result = await runDirTransfer({
    conn,
    title: `Downloading folder · ${target.config.name} · ${path.basename(local)}`,
    exclude: matcher,
    work: ({ progress, cancelled }) => conn.downloadDir(mapped.remoteAbs, local, {
      exclude: (rel) => matcher.ignores(rel),
      progress,
      cancelled,
    }),
  });
  if (!result) return;

  const scopeNote = mapped.relPath ? ` (${mapped.relPath})` : '';
  const s = summarizeDirResult('downloaded', target.config.name, scopeNote, result);
  if (s.kind === 'warn') vscode.window.showWarningMessage(s.text);
  else vscode.window.showInformationMessage(s.text);
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
  const safeKey = safeSegment(target.key);
  const segs = entry.relPath.split('/').map(safeSegment);
  const tmpPath = path.join(tmpRoot, 'remote', safeKey, ...segs);
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
  if (!target) { vscode.window.showErrorMessage('Target gone.'); return; }
  if (!node.entry.localAbs) return;

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
  if (!target) { vscode.window.showErrorMessage('Target gone.'); return; }
  if (!node.entry.remoteAbs) return;

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
  if (!target) { vscode.window.showErrorMessage('Target gone.'); return; }
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
  if (!target) { vscode.window.showErrorMessage('Target gone.'); return; }

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
