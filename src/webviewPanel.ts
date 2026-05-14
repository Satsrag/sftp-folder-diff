import * as vscode from 'vscode';
import { DiffEntry } from './diffEngine';

export class DiffWebviewPanel {
  private static current: DiffWebviewPanel | undefined;
  private panel: vscode.WebviewPanel;
  private entries: DiffEntry[] = [];
  private disposables: vscode.Disposable[] = [];

  private constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'sftpFolderDiff.table',
      'SFTP Folder Diff',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  static show(extensionUri: vscode.Uri, entries: DiffEntry[]) {
    if (!DiffWebviewPanel.current) {
      DiffWebviewPanel.current = new DiffWebviewPanel(extensionUri);
    }
    DiffWebviewPanel.current.update(entries);
    DiffWebviewPanel.current.panel.reveal();
  }

  static refresh(entries: DiffEntry[]) {
    DiffWebviewPanel.current?.update(entries);
  }

  private update(entries: DiffEntry[]) {
    this.entries = entries;
    this.panel.webview.html = this.render();
  }

  private async handleMessage(msg: any) {
    const entry = this.entries.find(e => e.relPath === msg.relPath);
    if (!entry) return;
    // Build a fake "node" structure to reuse existing commands
    const fakeNode = { entry };
    switch (msg.action) {
      case 'diff':
        await vscode.commands.executeCommand('sftpFolderDiff.openDiff', fakeNode);
        break;
      case 'upload':
        await vscode.commands.executeCommand('sftpFolderDiff.upload', fakeNode);
        break;
      case 'download':
        await vscode.commands.executeCommand('sftpFolderDiff.download', fakeNode);
        break;
      case 'deleteLocal':
        await vscode.commands.executeCommand('sftpFolderDiff.deleteLocal', fakeNode);
        break;
      case 'deleteRemote':
        await vscode.commands.executeCommand('sftpFolderDiff.deleteRemote', fakeNode);
        break;
      case 'recompare':
        await vscode.commands.executeCommand('sftpFolderDiff.compare');
        break;
    }
  }

  private render(): string {
    const rows = this.entries.map(e => {
      const lSize = e.localSize != null ? fmtSize(e.localSize) : '—';
      const rSize = e.remoteSize != null ? fmtSize(e.remoteSize) : '—';
      const lTime = e.localMtime ? fmtTime(e.localMtime) : '—';
      const rTime = e.remoteMtime ? fmtTime(e.remoteMtime) : '—';
      const statusLabel = {
        modified: 'M',
        localOnly: 'L only',
        remoteOnly: 'R only',
      }[e.status];

      const buttons: string[] = [];
      if (e.status === 'modified') {
        buttons.push(btn('diff', 'Diff', e.relPath));
        buttons.push(btn('upload', '↑ Upload', e.relPath));
        buttons.push(btn('download', '↓ Download', e.relPath));
      } else if (e.status === 'localOnly') {
        buttons.push(btn('diff', 'View', e.relPath));
        buttons.push(btn('upload', '↑ Upload', e.relPath));
        buttons.push(btn('deleteLocal', '✕ Local', e.relPath, 'danger'));
      } else {
        buttons.push(btn('diff', 'View', e.relPath));
        buttons.push(btn('download', '↓ Download', e.relPath));
        buttons.push(btn('deleteRemote', '✕ Remote', e.relPath, 'danger'));
      }

      return `
        <tr class="row status-${e.status}">
          <td><span class="badge ${e.status}">${statusLabel}</span></td>
          <td class="path">${escapeHtml(e.relPath)}</td>
          <td class="num">${rSize}</td>
          <td class="time">${rTime}</td>
          <td class="num">${lSize}</td>
          <td class="time">${lTime}</td>
          <td class="actions">${buttons.join('')}</td>
        </tr>`;
    }).join('');

    const counts = countByStatus(this.entries);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .summary { font-size: 12px; opacity: 0.85; }
  .filter { margin-left: auto; }
  .filter input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
  th { font-weight: 600; opacity: 0.8; position: sticky; top: 0; background: var(--vscode-editor-background); }
  .num, .time { font-variant-numeric: tabular-nums; font-size: 12px; opacity: 0.9; white-space: nowrap; }
  .path { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .badge.modified   { background: rgba(204, 167, 0, 0.25);  color: #cca700; }
  .badge.localOnly  { background: rgba(73, 156, 84, 0.25);  color: #4cba5a; }
  .badge.remoteOnly { background: rgba(220, 90, 90, 0.25);  color: #e06060; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .group-header { background: var(--vscode-editor-inactiveSelectionBackground); font-size: 11px; opacity: 0.7; text-transform: uppercase; }
  .actions { white-space: nowrap; }
  .actions button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; margin-left: 4px; cursor: pointer; font-size: 11px; border-radius: 2px; }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions button.danger { background: rgba(220, 90, 90, 0.6); color: #fff; }
  .actions button.danger:hover { background: rgba(220, 90, 90, 0.9); }
  .empty { text-align: center; padding: 40px; opacity: 0.6; }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="vscode.postMessage({action:'recompare'})">↻ Re-compare</button>
    <div class="summary">
      <span class="badge modified">M</span> ${counts.modified}
      &nbsp;
      <span class="badge localOnly">L only</span> ${counts.localOnly}
      &nbsp;
      <span class="badge remoteOnly">R only</span> ${counts.remoteOnly}
      &nbsp;&nbsp; total: ${this.entries.length}
    </div>
    <div class="filter">
      <input id="filter" placeholder="filter path..." oninput="onFilter()">
    </div>
  </div>
  ${this.entries.length === 0
    ? '<div class="empty">No differences. ✨</div>'
    : `<table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Path</th>
            <th colspan="2" style="text-align:center;border-bottom:1px solid var(--vscode-panel-border)">Remote</th>
            <th colspan="2" style="text-align:center;border-bottom:1px solid var(--vscode-panel-border)">Local</th>
            <th>Actions</th>
          </tr>
          <tr>
            <th></th><th></th>
            <th>size</th><th>mtime</th>
            <th>size</th><th>mtime</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="tbody">${rows}</tbody>
      </table>`
  }

<script>
  const vscode = acquireVsCodeApi();
  function act(action, relPath) {
    vscode.postMessage({ action, relPath });
  }
  function onFilter() {
    const q = document.getElementById('filter').value.toLowerCase();
    document.querySelectorAll('#tbody tr').forEach(tr => {
      const p = tr.querySelector('.path');
      if (!p) return;
      tr.style.display = p.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
</script>
</body>
</html>`;
  }

  private dispose() {
    DiffWebviewPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function btn(action: string, label: string, relPath: string, cls = ''): string {
  const safeRel = relPath.replace(/'/g, "\\'");
  return `<button class="${cls}" onclick="act('${action}', '${safeRel}')">${label}</button>`;
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ms: number): string {
  // SFTP often gives seconds; tolerate both.
  const n = ms > 1e12 ? ms : ms * 1000;
  const d = new Date(n);
  if (isNaN(d.getTime())) return '—';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function countByStatus(entries: DiffEntry[]) {
  const c = { modified: 0, localOnly: 0, remoteOnly: 0 };
  for (const e of entries) c[e.status]++;
  return c;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
