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
