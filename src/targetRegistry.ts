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
  errors: string[];                         // exactly one message when ok=false; empty otherwise
}

const CONFIG_RELATIVE = '.vscode/sftp-diff.json';

export class TargetRegistry {
  private targets: Map<string, Target> = new Map();
  private passwordCache: Map<string, string> = new Map();
  private pendingPrompt: Map<string, Promise<string>> = new Map();

  constructor(private workspaceRoot: string) {}

  /**
   * (Re)read .vscode/sftp-diff.json. On parse/validation failure (bad JSON,
   * wrong shape, duplicate names, overlapping paths), prior state is
   * preserved so the user can keep editing without losing in-progress work.
   * On a missing config file, all targets are disconnected and dropped
   * (the user explicitly removed the config). On success, surviving targets
   * keep their runtime state; renamed/moved/removed targets get their sftp
   * disconnected and lastDiff dropped.
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
        if (isAncestorOrEqual(a, b)) {
          return {
            ok: false,
            errors: [`targets[${i}] and targets[${j}] have overlapping localPath: ${a} ⊂ ${b}`],
          };
        }
        if (isAncestorOrEqual(b, a)) {
          return {
            ok: false,
            errors: [`targets[${i}] and targets[${j}] have overlapping localPath: ${b} ⊂ ${a}`],
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
        let pending = this.pendingPrompt.get(credKey);
        if (!pending) {
          pending = (async () => {
            const entered = await vscode.window.showInputBox({
              prompt: `SFTP password for ${cfg.username}@${cfg.host}`,
              password: true,
              ignoreFocusOut: true,
              placeHolder: 'kept in memory only for this VSCode session',
            });
            if (!entered) throw new Error('no password entered');
            this.passwordCache.set(credKey, entered);
            return entered;
          })();
          this.pendingPrompt.set(credKey, pending);
          try {
            pwd = await pending;
          } finally {
            this.pendingPrompt.delete(credKey);
          }
        } else {
          pwd = await pending;
        }
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
