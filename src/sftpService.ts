import * as fs from 'fs';
import * as path from 'path';
import Client = require('ssh2-sftp-client');

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  remotePath: string;
  localPath?: string;
  exclude?: string[];
}

export interface RemoteEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
}

export type TransferStep = (transferred: number, total: number) => void;

export interface DirTransferProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentFile: string;
}

export interface DirTransferOptions {
  /** Return true to skip a path (relative to the transfer root, posix). */
  exclude?: (relPath: string) => boolean;
  progress?: (info: DirTransferProgress) => void;
  /** Polled between files; if true, the loop exits early with cancelled=true. */
  cancelled?: () => boolean;
}

export interface DirTransferResult {
  filesTransferred: number;
  filesFailed: number;
  bytesTransferred: number;
  errors: Array<{ relPath: string; error: string }>;
  cancelled: boolean;
}

interface LocalFileForUpload { relPath: string; localAbs: string; size: number; }
interface RemoteFileForDownload { relPath: string; remoteAbs: string; size: number; }

export class SftpService {
  private client = new Client();
  private connected = false;
  private cfg?: SftpConfig;
  private reconnecting?: Promise<void>;

  constructor() {
    this.bindEvents(this.client);
  }

  async connect(cfg: SftpConfig): Promise<void> {
    this.cfg = cfg;
    if (this.connected) return;
    await this.doConnect();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try { await this.client.end(); } catch { /* ignore */ }
  }

  async list(remoteDir: string): Promise<RemoteEntry[]> {
    return this.run(async () => {
      const items = await this.client.list(remoteDir);
      return items.map(i => ({
        name: i.name,
        type: i.type as 'd' | '-' | 'l',
        size: i.size,
        modifyTime: i.modifyTime,
      }));
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.run(async () => (await this.client.exists(remotePath)) !== false);
  }

  async download(remotePath: string, localPath: string, step?: TransferStep): Promise<void> {
    return this.run(async () => {
      const opts: any = step
        ? { step: (t: number, _c: number, total: number) => step(t, total) }
        : undefined;
      await this.client.fastGet(remotePath, localPath, opts);
    });
  }

  async upload(localPath: string, remotePath: string, step?: TransferStep): Promise<void> {
    return this.run(async () => {
      // ensure remote parent exists
      const parent = remotePath.substring(0, remotePath.lastIndexOf('/'));
      if (parent) {
        const exists = await this.client.exists(parent);
        if (!exists) await this.client.mkdir(parent, true);
      }
      const opts: any = step
        ? { step: (t: number, _c: number, total: number) => step(t, total) }
        : undefined;
      await this.client.fastPut(localPath, remotePath, opts);
    });
  }

  async deleteRemote(remotePath: string): Promise<void> {
    await this.run(() => this.client.delete(remotePath));
  }

  /**
   * Upload a local directory recursively, file-by-file. Replaces the
   * ssh2-sftp-client built-in so we can:
   *   - honor an `exclude` predicate (glob/gitignore-style, callers' choice),
   *   - report per-file progress (filesDone/filesTotal + bytesDone/bytesTotal + currentFile),
   *   - cooperate with a cancellation token (checked between files; the file
   *     currently uploading is not interrupted mid-transfer because fastPut
   *     does not expose a cancel hook).
   * Returns a result describing what was transferred / skipped / failed.
   */
  async uploadDir(
    localDir: string,
    remoteDir: string,
    options: DirTransferOptions = {},
  ): Promise<DirTransferResult> {
    const exclude = options.exclude ?? (() => false);

    // Phase 1: walk local tree to enumerate files (synchronous, no SFTP yet).
    const files: LocalFileForUpload[] = [];
    this.walkLocalForUpload(localDir, '', exclude, files);
    const bytesTotal = files.reduce((s, f) => s + f.size, 0);

    const emptyResult = (cancelled: boolean, filesDone: number, bytesDone: number, errors: DirTransferResult['errors'], filesFailed: number): DirTransferResult => ({
      filesTransferred: filesDone,
      filesFailed,
      bytesTransferred: bytesDone,
      errors,
      cancelled,
    });

    // Phase 2: ensure remote root + every intermediate dir for the file set.
    if (options.cancelled?.()) return emptyResult(true, 0, 0, [], 0);
    await this.run(async () => {
      const ex = await this.client.exists(remoteDir);
      if (!ex) await this.client.mkdir(remoteDir, true);
    });

    const remoteDirs = new Set<string>();
    for (const f of files) {
      const parts = f.relPath.split('/');
      parts.pop(); // file name
      let cur = remoteDir;
      for (const p of parts) {
        cur = joinRemote(cur, p);
        remoteDirs.add(cur);
      }
    }
    for (const d of [...remoteDirs].sort()) {
      if (options.cancelled?.()) return emptyResult(true, 0, 0, [], 0);
      await this.run(async () => {
        const ex = await this.client.exists(d);
        if (!ex) await this.client.mkdir(d, true);
      });
    }

    // Phase 3: upload each file. Cancel is polled between files.
    let filesDone = 0;
    let bytesDone = 0;
    let filesFailed = 0;
    const errors: DirTransferResult['errors'] = [];

    options.progress?.({ filesDone, filesTotal: files.length, bytesDone, bytesTotal, currentFile: '' });

    for (const f of files) {
      if (options.cancelled?.()) {
        return emptyResult(true, filesDone, bytesDone, errors, filesFailed);
      }
      options.progress?.({
        filesDone,
        filesTotal: files.length,
        bytesDone,
        bytesTotal,
        currentFile: f.relPath,
      });
      const remotePath = joinRemote(remoteDir, f.relPath);
      try {
        await this.run(() => this.client.fastPut(f.localAbs, remotePath));
        filesDone++;
        bytesDone += f.size;
      } catch (e: any) {
        filesFailed++;
        errors.push({ relPath: f.relPath, error: e?.message || String(e) });
      }
    }

    options.progress?.({ filesDone, filesTotal: files.length, bytesDone, bytesTotal, currentFile: '' });
    return emptyResult(false, filesDone, bytesDone, errors, filesFailed);
  }

  /**
   * Download a remote directory recursively, file-by-file. Mirror of uploadDir;
   * see that method's doc for the rationale.
   */
  async downloadDir(
    remoteDir: string,
    localDir: string,
    options: DirTransferOptions = {},
  ): Promise<DirTransferResult> {
    const exclude = options.exclude ?? (() => false);

    // Phase 1: walk remote (SFTP list per directory). Counted as part of the
    // operation but we do not surface separate progress for this phase — most
    // trees enumerate in well under a second.
    const files: RemoteFileForDownload[] = [];
    await this.walkRemoteForDownload(remoteDir, '', exclude, files, options);
    const bytesTotal = files.reduce((s, f) => s + f.size, 0);

    const emptyResult = (cancelled: boolean, filesDone: number, bytesDone: number, errors: DirTransferResult['errors'], filesFailed: number): DirTransferResult => ({
      filesTransferred: filesDone,
      filesFailed,
      bytesTransferred: bytesDone,
      errors,
      cancelled,
    });

    if (options.cancelled?.()) return emptyResult(true, 0, 0, [], 0);

    // Phase 2: ensure local root exists.
    fs.mkdirSync(localDir, { recursive: true });

    // Phase 3: download each file. Cancel polled between files.
    let filesDone = 0;
    let bytesDone = 0;
    let filesFailed = 0;
    const errors: DirTransferResult['errors'] = [];

    options.progress?.({ filesDone, filesTotal: files.length, bytesDone, bytesTotal, currentFile: '' });

    for (const f of files) {
      if (options.cancelled?.()) {
        return emptyResult(true, filesDone, bytesDone, errors, filesFailed);
      }
      options.progress?.({
        filesDone,
        filesTotal: files.length,
        bytesDone,
        bytesTotal,
        currentFile: f.relPath,
      });
      const localAbs = path.join(localDir, ...f.relPath.split('/'));
      try {
        fs.mkdirSync(path.dirname(localAbs), { recursive: true });
        await this.run(() => this.client.fastGet(f.remoteAbs, localAbs));
        filesDone++;
        bytesDone += f.size;
      } catch (e: any) {
        filesFailed++;
        errors.push({ relPath: f.relPath, error: e?.message || String(e) });
      }
    }

    options.progress?.({ filesDone, filesTotal: files.length, bytesDone, bytesTotal, currentFile: '' });
    return emptyResult(false, filesDone, bytesDone, errors, filesFailed);
  }

  async readBuffer(remotePath: string): Promise<Buffer> {
    return this.run(async () => {
      const data = await this.client.get(remotePath);
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') return Buffer.from(data);
      throw new Error('Unexpected get() return type');
    });
  }

  // ---- walkers (private, no progress; the caller drives a per-file progress callback) ----

  private walkLocalForUpload(
    base: string,
    rel: string,
    exclude: (relPath: string) => boolean,
    out: LocalFileForUpload[],
  ): void {
    const dir = path.join(base, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude(childRel)) continue;
      const childAbs = path.join(base, childRel);
      if (e.isDirectory()) {
        this.walkLocalForUpload(base, childRel, exclude, out);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(childAbs);
          out.push({ relPath: childRel, localAbs: childAbs, size: st.size });
        } catch {
          // unreadable file — skip silently
        }
      }
      // symlinks deliberately skipped
    }
  }

  private async walkRemoteForDownload(
    base: string,
    rel: string,
    exclude: (relPath: string) => boolean,
    out: RemoteFileForDownload[],
    options: DirTransferOptions,
  ): Promise<void> {
    if (options.cancelled?.()) return;
    const dir = rel ? joinRemote(base, rel) : base;
    let entries: RemoteEntry[];
    try {
      entries = await this.list(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (options.cancelled?.()) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude(childRel)) continue;
      const childAbs = joinRemote(base, childRel);
      if (e.type === 'd') {
        await this.walkRemoteForDownload(base, childRel, exclude, out, options);
      } else if (e.type === '-') {
        out.push({ relPath: childRel, remoteAbs: childAbs, size: e.size });
      }
      // symlinks deliberately skipped
    }
  }

  // ---- transparent reconnect plumbing ----

  /**
   * Run an op; on a disconnect-shaped error reconnect once and retry.
   * Also reconnects up-front if our local flag says we're down (caught
   * via the 'close'/'end' events bound below).
   */
  private async run<T>(op: () => Promise<T>): Promise<T> {
    if (!this.connected) await this.reconnect();
    try {
      return await op();
    } catch (e: any) {
      if (!this.isDisconnect(e)) throw e;
      await this.reconnect();
      return await op();
    }
  }

  /** Single-flight: concurrent ops share one reconnect attempt. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const p = this.doConnect();
    this.reconnecting = p;
    try { await p; } finally { this.reconnecting = undefined; }
  }

  private async doConnect(): Promise<void> {
    const cfg = this.cfg!;
    this.connected = false;
    // Drop any stale client — never reuse a torn-down one.
    try { await this.client.end(); } catch { /* ignore — likely was never up */ }
    this.client = new Client();
    this.bindEvents(this.client);

    const opts: any = {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      readyTimeout: 20000,
    };
    if (cfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(cfg.privateKeyPath);
    } else if (cfg.password) {
      opts.password = cfg.password;
    }
    await this.client.connect(opts);
    this.connected = true;
  }

  private bindEvents(c: Client) {
    // ssh2-sftp-client's Client extends EventEmitter but the typings don't
    // expose `on`. Cast to access the events that flag a dead session.
    const ee = c as unknown as { on?: (ev: string, fn: (...args: any[]) => void) => void };
    if (typeof ee.on !== 'function') return;
    ee.on('close', () => { this.connected = false; });
    ee.on('end',   () => { this.connected = false; });
    ee.on('error', () => { this.connected = false; });
  }

  private isDisconnect(e: any): boolean {
    const msg = String(e?.message || e || '').toLowerCase();
    const code = String(e?.code || '').toLowerCase();
    if (
      code === 'econnreset' || code === 'etimedout' || code === 'econnaborted' ||
      code === 'epipe' || code === 'enotconn'
    ) return true;
    return msg.includes('not connected')
      || msg.includes('no sftp connection')
      || msg.includes('connection closed')
      || msg.includes('connection reset')
      || msg.includes('connection lost')
      || msg.includes('connection ended')
      || msg.includes('channel open failure')
      || msg.includes('socket hang up');
  }
}

function joinRemote(base: string, rel: string): string {
  if (!rel) return base;
  return base.endsWith('/') ? base + rel : base + '/' + rel;
}
