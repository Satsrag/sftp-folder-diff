import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SftpService } from './sftpService';
import { GlobMatcher } from './globMatcher';

export type DiffStatus = 'localOnly' | 'remoteOnly' | 'modified';

export interface DiffEntry {
  relPath: string;       // posix style, relative
  status: DiffStatus;
  localAbs?: string;     // absolute local fs path
  remoteAbs?: string;    // absolute remote posix path
  localSize?: number;
  remoteSize?: number;
  localMtime?: number;
  remoteMtime?: number;
}

type CompareMode = 'fast' | 'smart' | 'content';

interface LocalFile { relPath: string; abs: string; size: number; mtime: number; }
interface RemoteFile { relPath: string; abs: string; size: number; mtime: number; }

export class DiffEngine {
  private matcher: GlobMatcher;
  constructor(
    private sftp: SftpService,
    private localBase: string,
    private remoteBase: string,
    ignore: string[],
    private mode: CompareMode,
  ) {
    this.matcher = new GlobMatcher(ignore);
  }

  async run(progress: (msg: string) => void): Promise<DiffEntry[]> {
    // Phase 1: local scan
    progress('📂 Scanning local files...');
    let localDirCount = 0;
    let localFileCount = 0;
    let lastTick = Date.now();
    const localTick = (isDir: boolean) => {
      if (isDir) localDirCount++; else localFileCount++;
      const now = Date.now();
      if (now - lastTick > 150) {
        progress(`📂 Scanning local: ${localFileCount} files in ${localDirCount} dirs...`);
        lastTick = now;
      }
    };
    const localFiles = await this.walkLocal(this.localBase, '', localTick);
    progress(`✓ Local: ${localFiles.length} files. Now scanning remote...`);

    // Phase 2: remote scan
    let remoteDirCount = 0;
    let remoteFileCount = 0;
    lastTick = Date.now();
    const remoteTick = (isDir: boolean) => {
      if (isDir) remoteDirCount++; else remoteFileCount++;
      const now = Date.now();
      if (now - lastTick > 150) {
        progress(`🌐 Scanning remote: ${remoteFileCount} files in ${remoteDirCount} dirs...`);
        lastTick = now;
      }
    };
    const remoteFiles = await this.walkRemote(this.remoteBase, '', remoteTick);
    progress(`✓ Remote: ${remoteFiles.length} files. Comparing...`);

    const localMap = new Map(localFiles.map(f => [f.relPath, f]));
    const remoteMap = new Map(remoteFiles.map(f => [f.relPath, f]));

    const results: DiffEntry[] = [];
    const totalToCheck = localMap.size;
    let checked = 0;
    lastTick = Date.now();

    // local-only and modified
    for (const [rel, lf] of localMap) {
      checked++;
      const rf = remoteMap.get(rel);
      if (!rf) {
        results.push({
          relPath: rel,
          status: 'localOnly',
          localAbs: lf.abs,
          remoteAbs: this.joinRemote(this.remoteBase, rel),
          localSize: lf.size,
          localMtime: lf.mtime,
        });
        continue;
      }
      // Show what's currently being compared in content mode (it's slow).
      if (this.mode === 'content') {
        const now = Date.now();
        if (now - lastTick > 100) {
          progress(`🔍 Hashing ${checked}/${totalToCheck}: ${truncMid(rel, 50)}`);
          lastTick = now;
        }
      } else {
        const now = Date.now();
        if (now - lastTick > 200) {
          progress(`🔍 Comparing ${checked}/${totalToCheck}...`);
          lastTick = now;
        }
      }
      const same = await this.filesEqual(lf, rf);
      if (!same) {
        results.push({
          relPath: rel,
          status: 'modified',
          localAbs: lf.abs,
          remoteAbs: rf.abs,
          localSize: lf.size,
          remoteSize: rf.size,
          localMtime: lf.mtime,
          remoteMtime: rf.mtime,
        });
      }
    }

    // remote-only
    for (const [rel, rf] of remoteMap) {
      if (!localMap.has(rel)) {
        results.push({
          relPath: rel,
          status: 'remoteOnly',
          remoteAbs: rf.abs,
          localAbs: path.join(this.localBase, rel),
          remoteSize: rf.size,
          remoteMtime: rf.mtime,
        });
      }
    }

    progress(`✨ Done. ${results.length} differences.`);
    // sort for stable display
    results.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return results;
  }

  private async filesEqual(lf: LocalFile, rf: RemoteFile): Promise<boolean> {
    // size mismatch ⇒ definitely different, in any mode
    if (lf.size !== rf.size) return false;

    // mtime in ms; allow 2s drift
    const mtimeClose = Math.abs(lf.mtime - rf.mtime) < 2000;

    if (this.mode === 'fast') return mtimeClose;
    // smart: trust size+mtime when both agree, fall through to hash on drift
    if (this.mode === 'smart' && mtimeClose) return true;

    const [lh, rh] = await Promise.all([
      this.hashLocal(lf.abs),
      this.hashRemote(rf.abs),
    ]);
    return lh === rh;
  }

  private hashLocal(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('data', d => h.update(d));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', reject);
    });
  }

  private async hashRemote(p: string): Promise<string> {
    const buf = await this.sftp.readBuffer(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  private async walkLocal(
    base: string,
    rel: string,
    tick?: (isDir: boolean) => void,
  ): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const dir = path.join(base, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    if (tick) tick(true);
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (this.matcher.ignores(childRel)) continue;
      const childAbs = path.join(base, childRel);
      if (e.isDirectory()) {
        out.push(...await this.walkLocal(base, childRel, tick));
      } else if (e.isFile()) {
        const st = fs.statSync(childAbs);
        out.push({
          relPath: childRel,
          abs: childAbs,
          size: st.size,
          mtime: st.mtimeMs,
        });
        if (tick) tick(false);
      }
    }
    return out;
  }

  private async walkRemote(
    base: string,
    rel: string,
    tick?: (isDir: boolean) => void,
  ): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    const dir = this.joinRemote(base, rel);
    let entries;
    try {
      entries = await this.sftp.list(dir);
    } catch {
      return out;
    }
    if (tick) tick(true);
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (this.matcher.ignores(childRel)) continue;
      const childAbs = this.joinRemote(base, childRel);
      if (e.type === 'd') {
        out.push(...await this.walkRemote(base, childRel, tick));
      } else if (e.type === '-') {
        out.push({
          relPath: childRel,
          abs: childAbs,
          size: e.size,
          mtime: e.modifyTime,
        });
        if (tick) tick(false);
      }
      // ignoring symlinks for simplicity
    }
    return out;
  }

  private joinRemote(base: string, rel: string): string {
    if (!rel) return base;
    return base.endsWith('/') ? base + rel : base + '/' + rel;
  }
}

/** Truncate a string in the middle with an ellipsis: "abc…xyz". */
function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return s.slice(0, left) + '…' + s.slice(s.length - right);
}
