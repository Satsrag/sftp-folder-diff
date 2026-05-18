import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpService, SftpConfig } from './sftpService';
import { DiffEngine, DiffEntry } from './diffEngine';
import { DiffTreeProvider, DiffNode } from './treeView';
import { DiffWebviewPanel } from './webviewPanel';

const CONFIG_FILE = '.vscode/sftp-diff.json';

let sftp: SftpService | null = null;
let treeProvider: DiffTreeProvider;
let lastDiff: DiffEntry[] = [];
let _extensionUri: vscode.Uri;

// In-memory only — never written to disk. Cleared on VSCode exit.
let sessionPassword: string | undefined;

/* ---------- progress helpers ---------- */

/**
 * For long-running operations without granular progress (like recursive
 * folder upload/download), show a notification with a small animated spinner
 * suffix and an elapsed timer.
 */
async function withSpinnerProgress(
  title: string,
  work: () => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async (progress) => {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      const start = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const mm = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const ss = (elapsed % 60).toString().padStart(2, '0');
        progress.report({
          message: `${frames[i++ % frames.length]} working...  ${mm}:${ss} elapsed`,
        });
      }, 120);
      try {
        await work();
      } finally {
        clearInterval(timer);
      }
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

/**
 * Wrap a single-file transfer with a notification progress bar that reports
 * "X / Y" + percent. `op` is a verb like "Downloading" or "Uploading".
 */
async function withTransferProgress(
  op: string,
  filename: string,
  work: (step: (transferred: number, total: number) => void) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${op} ${filename}`,
      cancellable: false,
    },
    async (progress) => {
      let lastReported = 0;
      let total = 0;
      let lastTick = Date.now();
      const step = (transferred: number, t: number) => {
        total = t;
        const now = Date.now();
        // throttle: at most every 80ms
        if (now - lastTick < 80 && transferred < total) return;
        lastTick = now;
        const pct = total > 0 ? Math.floor((transferred / total) * 100) : 0;
        const delta = transferred - lastReported;
        lastReported = transferred;
        progress.report({
          message: `${fmtBytes(transferred)} / ${fmtBytes(total)} · ${pct}%`,
          // increment for the bar itself (it's relative)
          increment: total > 0 ? (delta / total) * 100 : undefined,
        });
      };
      progress.report({ message: 'preparing...' });
      await work(step);
      progress.report({ message: '✓ done' });
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  _extensionUri = context.extensionUri;
  treeProvider = new DiffTreeProvider();
  vscode.window.registerTreeDataProvider('sftpFolderDiff.tree', treeProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('sftpFolderDiff.configure', configureCmd),
    vscode.commands.registerCommand('sftpFolderDiff.compare', () => compareCmd()),
    vscode.commands.registerCommand('sftpFolderDiff.compareFolder', compareFolderCmd),
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
    vscode.commands.registerCommand('sftpFolderDiff.showTable', showTableCmd),
  );
}

export function deactivate() {
  sftp?.disconnect();
  sessionPassword = undefined;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function readConfig(): SftpConfig | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  const p = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    vscode.window.showErrorMessage('sftp-diff.json is not valid JSON');
    return undefined;
  }
}

function getEffectiveExclude(cfg: SftpConfig): string[] {
  // Config file takes precedence; fall back to VSCode setting.
  if (Array.isArray(cfg.exclude) && cfg.exclude.length > 0) return cfg.exclude;
  return vscode.workspace.getConfiguration('sftpFolderDiff').get<string[]>('ignore', []);
}

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
    const template: SftpConfig = {
      host: 'example.com',
      port: 22,
      username: 'user',
      password: '',
      privateKeyPath: '',
      remotePath: '/var/www/project',
      localPath: '.',
      exclude: ['node_modules', '.git', '.vscode', 'dist', 'out', '.DS_Store'],
    };
    fs.writeFileSync(target, JSON.stringify(template, null, 2));
  }
  const doc = await vscode.workspace.openTextDocument(target);
  vscode.window.showTextDocument(doc);
}

async function clearPasswordCmd() {
  sessionPassword = undefined;
  await sftp?.disconnect();
  sftp = null;
  vscode.window.showInformationMessage('Session password cleared.');
}

async function ensureConnected(): Promise<SftpService | undefined> {
  const cfg = readConfig();
  if (!cfg) {
    const pick = await vscode.window.showWarningMessage(
      'No sftp-diff.json found. Create one?', 'Yes', 'No'
    );
    if (pick === 'Yes') await configureCmd();
    return undefined;
  }

  // Auth selection: privateKeyPath wins; else use config password; else prompt and cache in memory.
  const hasKey = !!(cfg.privateKeyPath && cfg.privateKeyPath.trim());
  const hasConfigPassword = !!(cfg.password && cfg.password.length > 0);

  const runtimeCfg: SftpConfig = { ...cfg };

  if (!hasKey && !hasConfigPassword) {
    if (!sessionPassword) {
      const entered = await vscode.window.showInputBox({
        prompt: `SFTP password for ${cfg.username}@${cfg.host}`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'kept in memory only for this VSCode session',
      });
      if (!entered) {
        vscode.window.showWarningMessage('No password entered, aborting.');
        return undefined;
      }
      sessionPassword = entered;
    }
    runtimeCfg.password = sessionPassword;
  }

  if (!sftp) sftp = new SftpService();
  try {
    await sftp.connect(runtimeCfg);
    return sftp;
  } catch (e: any) {
    const msg = String(e?.message || e);
    // If auth-related, drop cached password so user can re-enter next time.
    if (/auth|password|permission/i.test(msg) && !hasKey && !hasConfigPassword) {
      sessionPassword = undefined;
    }
    sftp = null;
    vscode.window.showErrorMessage(`SFTP connect failed: ${msg}`);
    return undefined;
  }
}

/**
 * Main compare entry. `subFolderAbs` (optional) lets us compare a subfolder only.
 */
async function compareCmd(subFolderAbs?: string) {
  const cfg = readConfig();
  const root = getWorkspaceRoot();
  if (!cfg || !root) return;

  const conn = await ensureConnected();
  if (!conn) return;

  const workspaceLocalBase = path.resolve(root, cfg.localPath || '.');
  let localBase = workspaceLocalBase;
  let remoteBase = cfg.remotePath;
  let scopeNote = '';

  if (subFolderAbs) {
    const abs = path.resolve(subFolderAbs);
    const rel = path.relative(workspaceLocalBase, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      vscode.window.showErrorMessage(
        `Selected folder is outside localPath (${workspaceLocalBase}).`
      );
      return;
    }
    if (rel) {
      localBase = abs;
      const posixRel = rel.replace(/\\/g, '/');
      remoteBase = remoteBase.endsWith('/')
        ? remoteBase + posixRel
        : remoteBase + '/' + posixRel;
      scopeNote = ` (scope: ${posixRel})`;
    }
  }

  const exclude = getEffectiveExclude(cfg);
  const mode = vscode.workspace
    .getConfiguration('sftpFolderDiff')
    .get<'fast' | 'smart' | 'content'>('compareMode', 'smart');

  let cancelled = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SFTP Diff${scopeNote} · ${mode} mode`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: '🔌 Connecting...' });
      const engine = new DiffEngine(conn, '', localBase, remoteBase, exclude, mode);
      try {
        const result = await engine.run(
          (msg) => progress.report({ message: msg }),
          () => token.isCancellationRequested,
        );
        lastDiff = result;
        treeProvider.setData(lastDiff, localBase, remoteBase);
        DiffWebviewPanel.refresh(lastDiff);
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
    vscode.window.showInformationMessage(`Diff cancelled${scopeNote}. Previous results kept.`);
    return;
  }
  // Auto-reveal the sidebar so the user sees results without an extra click.
  await vscode.commands.executeCommand('sftpFolderDiff.tree.focus');
  const summary = summarizeDiff(lastDiff);
  vscode.window.showInformationMessage(
    `Diff done${scopeNote}: ${summary}`
  );
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

/** Right-click on a folder in Explorer → compare just that subfolder. */
async function compareFolderCmd(uri?: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No folder selected.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(uri.fsPath);
  } catch {
    vscode.window.showErrorMessage('Path does not exist.');
    return;
  }
  if (!stat.isDirectory()) {
    vscode.window.showErrorMessage('Please right-click a folder, not a file.');
    return;
  }
  await compareCmd(uri.fsPath);
}

/**
 * Map a local absolute path inside the workspace to its corresponding remote
 * posix path according to localPath/remotePath in sftp-diff.json.
 * Returns undefined (with error toast) if not under localPath.
 */
function mapLocalToRemote(localAbs: string): { remoteAbs: string; relPath: string } | undefined {
  const cfg = readConfig();
  const root = getWorkspaceRoot();
  if (!cfg || !root) return undefined;
  const localBase = path.resolve(root, cfg.localPath || '.');
  const rel = path.relative(localBase, path.resolve(localAbs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    vscode.window.showErrorMessage(
      `Path is outside localPath (${localBase}): ${localAbs}`
    );
    return undefined;
  }
  const posixRel = rel.replace(/\\/g, '/');
  const remoteBase = cfg.remotePath;
  const remoteAbs = !posixRel
    ? remoteBase
    : remoteBase.endsWith('/')
      ? remoteBase + posixRel
      : remoteBase + '/' + posixRel;
  return { remoteAbs, relPath: posixRel };
}

/**
 * Resolve a URI argument. If absent (command palette), fall back to active editor.
 * Returns fs path or undefined (with toast).
 */
function resolveTargetPath(uri?: vscode.Uri): string | undefined {
  if (uri && uri.fsPath) return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') return active.fsPath;
  vscode.window.showErrorMessage('No file selected and no active editor.');
  return undefined;
}

/** Right-click file → diff that one file against remote. */
async function diffFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
    vscode.window.showErrorMessage('Not a file.');
    return;
  }
  const mapped = mapLocalToRemote(local);
  if (!mapped) return;

  const conn = await ensureConnected();
  if (!conn) return;

  const tmpRoot = path.join(require('os').tmpdir(), 'sftp-folder-diff', String(process.pid));
  const tmpPath = path.join(tmpRoot, 'remote', ...mapped.relPath.split('/'));
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
    `${path.basename(local)}  (Remote ↔ Local)`,
    { preview: true }
  );
}

/** Right-click file → upload that one file. */
async function uploadFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
    vscode.window.showErrorMessage('Not a file.');
    return;
  }
  const mapped = mapLocalToRemote(local);
  if (!mapped) return;

  const conn = await ensureConnected();
  if (!conn) return;

  try {
    await withTransferProgress(
      'Uploading',
      path.basename(local),
      (step) => conn.upload(local, mapped.remoteAbs, step)
    );
    vscode.window.showInformationMessage(`Uploaded: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Upload failed: ${e.message}`);
  }
}

/** Right-click file → download remote counterpart to overwrite local. */
async function downloadFileCmd(uri?: vscode.Uri) {
  const local = resolveTargetPath(uri);
  if (!local) return;
  // Even if local doesn't exist yet, we still allow downloading — but warn for overwrite.
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
  const mapped = mapLocalToRemote(local);
  if (!mapped) return;

  const conn = await ensureConnected();
  if (!conn) return;

  try {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await withTransferProgress(
      'Downloading',
      path.basename(local),
      (step) => conn.download(mapped.remoteAbs, local, step)
    );
    vscode.window.showInformationMessage(`Downloaded: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Download failed: ${e.message}`);
  }
}

/** Right-click folder → upload the whole folder recursively. */
async function uploadFolderCmd(uri?: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No folder selected.');
    return;
  }
  const local = uri.fsPath;
  if (!fs.existsSync(local) || !fs.statSync(local).isDirectory()) {
    vscode.window.showErrorMessage('Not a folder.');
    return;
  }
  const mapped = mapLocalToRemote(local);
  if (!mapped) return;

  const ok = await vscode.window.showWarningMessage(
    `Upload folder to remote? This may overwrite files.\nLocal:  ${local}\nRemote: ${mapped.remoteAbs}`,
    { modal: true }, 'Upload'
  );
  if (ok !== 'Upload') return;

  const conn = await ensureConnected();
  if (!conn) return;

  try {
    await withSpinnerProgress(
      `Uploading folder · ${path.basename(local)}`,
      () => conn.uploadDir(local, mapped.remoteAbs)
    );
    vscode.window.showInformationMessage(`Folder uploaded: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Folder upload failed: ${e.message}`);
  }
}

/** Right-click folder → download whole remote folder recursively to overwrite local. */
async function downloadFolderCmd(uri?: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No folder selected.');
    return;
  }
  const local = uri.fsPath;
  if (fs.existsSync(local) && !fs.statSync(local).isDirectory()) {
    vscode.window.showErrorMessage('Not a folder.');
    return;
  }
  const mapped = mapLocalToRemote(local);
  if (!mapped) return;

  const ok = await vscode.window.showWarningMessage(
    `Download folder from remote? This may overwrite local files.\nRemote: ${mapped.remoteAbs}\nLocal:  ${local}`,
    { modal: true }, 'Download'
  );
  if (ok !== 'Download') return;

  const conn = await ensureConnected();
  if (!conn) return;

  try {
    await withSpinnerProgress(
      `Downloading folder · ${path.basename(local)}`,
      () => conn.downloadDir(mapped.remoteAbs, local)
    );
    vscode.window.showInformationMessage(`Folder downloaded: ${mapped.relPath || path.basename(local)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Folder download failed: ${e.message}`);
  }
}

async function toggleModeCmd() {
  const cfg = vscode.workspace.getConfiguration('sftpFolderDiff');
  const order = ['fast', 'smart', 'content'] as const;
  const cur = cfg.get<typeof order[number]>('compareMode', 'smart');
  const next = order[(order.indexOf(cur) + 1) % order.length];
  await cfg.update('compareMode', next, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Compare mode: ${next}`);
}

async function openDiffCmd(node: DiffNode) {
  if (!node?.entry) return;
  const entry = node.entry;

  // localOnly: just open the local file, no remote involved
  if (entry.status === 'localOnly' && entry.localAbs) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localAbs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Open failed: ${e.message}`);
    }
    return;
  }

  // Need remote for modified and remoteOnly
  const conn = await ensureConnected();
  if (!conn) return;

  // Download remote into a temp file. Keep the original filename + extension
  // so VSCode picks the right language for syntax highlighting.
  // Use a unique session subdir to avoid collisions.
  const tmpRoot = path.join(require('os').tmpdir(), 'sftp-folder-diff', String(process.pid));
  // Re-create the path under tmpRoot, preserving directories.
  const tmpPath = path.join(tmpRoot, 'remote', ...entry.relPath.split('/'));
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

  try {
    const opLabel = entry.status === 'remoteOnly'
      ? 'Loading remote'
      : 'Loading remote (for diff)';
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
    // Just open the downloaded remote file in a read-only preview tab.
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
      await vscode.window.showTextDocument(doc, { preview: true });
      vscode.window.setStatusBarMessage(
        `Viewing remote-only: ${entry.relPath}`, 5000
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Open failed: ${e.message}`);
    }
    return;
  }

  // modified → side-by-side diff
  const left = vscode.Uri.file(tmpPath);
  const right = vscode.Uri.file(entry.localAbs!);
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${path.basename(entry.relPath)}  (Remote ↔ Local)`,
    { preview: true }
  );
}

async function uploadCmd(node: DiffNode) {
  const conn = await ensureConnected();
  if (!conn || !node?.entry) return;
  const e = node.entry;
  if (!e.localAbs) return;
  try {
    await withTransferProgress(
      'Uploading',
      path.basename(e.relPath),
      (step) => conn.upload(e.localAbs!, e.remoteAbs!, step)
    );
    vscode.window.showInformationMessage(`Uploaded: ${e.relPath}`);
    removeEntry(e);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
  }
}

async function downloadCmd(node: DiffNode) {
  const conn = await ensureConnected();
  if (!conn || !node?.entry) return;
  const e = node.entry;
  if (!e.remoteAbs) return;
  try {
    fs.mkdirSync(path.dirname(e.localAbs!), { recursive: true });
    await withTransferProgress(
      'Downloading',
      path.basename(e.relPath),
      (step) => conn.download(e.remoteAbs!, e.localAbs!, step)
    );
    vscode.window.showInformationMessage(`Downloaded: ${e.relPath}`);
    removeEntry(e);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

async function deleteLocalCmd(node: DiffNode) {
  if (!node?.entry?.localAbs) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete local file: ${node.entry.relPath}?`, { modal: true }, 'Delete'
  );
  if (ok !== 'Delete') return;
  fs.unlinkSync(node.entry.localAbs);
  removeEntry(node.entry);
}

async function deleteRemoteCmd(node: DiffNode) {
  const conn = await ensureConnected();
  if (!conn || !node?.entry?.remoteAbs) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete remote file: ${node.entry.relPath}?`, { modal: true }, 'Delete'
  );
  if (ok !== 'Delete') return;
  try {
    await conn.deleteRemote(node.entry.remoteAbs);
    removeEntry(node.entry);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Delete remote failed: ${e.message}`);
  }
}

function removeEntry(entry: DiffEntry) {
  lastDiff = lastDiff.filter(e => e.relPath !== entry.relPath);
  treeProvider.refreshAfterChange(lastDiff);
  DiffWebviewPanel.refresh(lastDiff);
}

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
