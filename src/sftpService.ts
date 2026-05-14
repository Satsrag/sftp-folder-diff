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

  async connect(cfg: SftpConfig): Promise<void> {
    if (this.connected) return;
    const opts: Client.ConnectOptions = {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
    };
    if (cfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(cfg.privateKeyPath);
    } else if (cfg.password) {
      opts.password = cfg.password;
    }
    await this.client.connect(opts);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try { await this.client.end(); } catch { /* ignore */ }
    this.connected = false;
  }

  async list(remoteDir: string): Promise<RemoteEntry[]> {
    const items = await this.client.list(remoteDir);
    return items.map(i => ({
      name: i.name,
      type: i.type as 'd' | '-' | 'l',
      size: i.size,
      modifyTime: i.modifyTime,
    }));
  }

  async exists(remotePath: string): Promise<boolean> {
    const r = await this.client.exists(remotePath);
    return r !== false;
  }

  async download(remotePath: string, localPath: string, step?: TransferStep): Promise<void> {
    const opts: any = step
      ? { step: (t: number, _c: number, total: number) => step(t, total) }
      : undefined;
    await this.client.fastGet(remotePath, localPath, opts);
  }

  async upload(localPath: string, remotePath: string, step?: TransferStep): Promise<void> {
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
  }

  async deleteRemote(remotePath: string): Promise<void> {
    await this.client.delete(remotePath);
  }

  /** Upload a whole local directory to remote, recursively. */
  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    // ensure remote dir exists
    const exists = await this.client.exists(remoteDir);
    if (!exists) await this.client.mkdir(remoteDir, true);
    // Use built-in uploadDir for recursive transfer.
    await this.client.uploadDir(localDir, remoteDir);
  }

  /** Download a whole remote directory to local, recursively. */
  async downloadDir(remoteDir: string, localDir: string): Promise<void> {
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(localDir, { recursive: true });
    await this.client.downloadDir(remoteDir, localDir);
  }

  async readBuffer(remotePath: string): Promise<Buffer> {
    const data = await this.client.get(remotePath);
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === 'string') return Buffer.from(data);
    // Stream case shouldn't happen with default get(), but guard:
    throw new Error('Unexpected get() return type');
  }
}
