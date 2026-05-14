import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, DiffStatus } from './diffEngine';

export class DiffNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly entry?: DiffEntry,
    public readonly children: DiffNode[] = [],
  ) {
    super(label, collapsibleState);
    if (entry) {
      this.contextValue = entry.status;
      this.description = describe(entry);
      this.iconPath = iconFor(entry.status);
      this.tooltip = `${entry.relPath}\n${entry.status}`;
      // All three states are clickable to preview content.
      // - modified  → side-by-side diff (remote ↔ local)
      // - localOnly → open local file
      // - remoteOnly → download remote into a virtual preview tab
      this.command = {
        command: 'sftpFolderDiff.openDiff',
        title: 'Open',
        arguments: [this],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }
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

export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private _onDidChange = new vscode.EventEmitter<DiffNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private root: DiffNode[] = [];

  setData(entries: DiffEntry[], localBase: string, remoteBase: string) {
    this.root = buildTree(entries);
    this._onDidChange.fire(undefined);
  }

  refreshAfterChange(entries: DiffEntry[]) {
    this.root = buildTree(entries);
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: DiffNode): vscode.TreeItem { return el; }

  getChildren(el?: DiffNode): DiffNode[] {
    if (!el) return this.root;
    return el.children;
  }
}

function buildTree(entries: DiffEntry[]): DiffNode[] {
  // Build a nested folder structure from posix-style relPaths.
  interface Dir { children: Map<string, Dir>; files: DiffEntry[]; }
  const root: Dir = { children: new Map(), files: [] };

  for (const e of entries) {
    const parts = e.relPath.split('/');
    const fname = parts.pop()!;
    let cur = root;
    for (const p of parts) {
      if (!cur.children.has(p)) cur.children.set(p, { children: new Map(), files: [] });
      cur = cur.children.get(p)!;
    }
    cur.files.push(e);
  }

  function toNodes(d: Dir): DiffNode[] {
    const out: DiffNode[] = [];
    // folders first
    const folderNames = [...d.children.keys()].sort();
    for (const name of folderNames) {
      const sub = d.children.get(name)!;
      const subNodes = toNodes(sub);
      out.push(new DiffNode(name, vscode.TreeItemCollapsibleState.Expanded, undefined, subNodes));
    }
    // then files
    d.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const e of d.files) {
      const fname = e.relPath.split('/').pop()!;
      out.push(new DiffNode(fname, vscode.TreeItemCollapsibleState.None, e));
    }
    return out;
  }
  return toNodes(root);
}
