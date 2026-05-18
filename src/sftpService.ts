import * as fs from 'fs';
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

  /** Upload a whole local directory to remote, recursively. */
  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this.run(async () => {
      const exists = await this.client.exists(remoteDir);
      if (!exists) await this.client.mkdir(remoteDir, true);
      await this.client.uploadDir(localDir, remoteDir);
    });
  }

  /** Download a whole remote directory to local, recursively. */
  async downloadDir(remoteDir: string, localDir: string): Promise<void> {
    return this.run(async () => {
      fs.mkdirSync(localDir, { recursive: true });
      await this.client.downloadDir(remoteDir, localDir);
    });
  }

  async readBuffer(remotePath: string): Promise<Buffer> {
    return this.run(async () => {
      const data = await this.client.get(remotePath);
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') return Buffer.from(data);
      throw new Error('Unexpected get() return type');
    });
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
