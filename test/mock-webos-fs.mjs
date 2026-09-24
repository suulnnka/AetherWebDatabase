/* ============================================================
 * 模拟 webos 虚拟文件系统(Node 测试用)
 *
 * 对齐 js/core/fs.js 的 inode 式拆分:
 *   · 元数据树:目录/文件节点(t/m/o/p),文件无内联 d(对齐 stripContents)
 *   · 内容存储:path → string(概念上等同 OPFS `webos/fsdata/<path>`)
 *   · 同步 read/write/exists/isDir/mkdir —— 对齐生产 fs 同步 API
 *
 * createFileBackend 只依赖 { read, write }:
 *   内容经 write 落入独立存储,不经元数据 JSON —— 与生产
 *   「fs.v2.json 仅 inode + fsdata 存内容」一致。
 *
 * 用法:
 *   import { createMockWebosFs } from './mock-webos-fs.mjs';
 *   const fs = createMockWebosFs();
 *   fs.mkdir('/home/u/appdata');
 *   const backend = createFileBackend(fs, '/home/u/appdata/sms.awdb');
 * ============================================================ */

export function createMockWebosFs() {
  /**
   * 元数据:绝对路径 → 目录标记或文件 inode(无 d)。
   * 目录用 null;文件用 { t:'f', m, o, p } —— 与 webos stripContents 后一致。
   * @type {Map<string, null | object>}
   */
  const meta = new Map([['/', null]]);

  /**
   * 文件内容(概念上 = OPFS fsdata/<path>)。
   * 键为绝对路径,与 meta 中 t==='f' 的项对应。
   * @type {Map<string, string>}
   */
  const contents = new Map();

  function norm(p) {
    const out = [];
    for (const seg of String(p || '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  }

  function ensureDir(path) {
    const n = norm(path);
    if (n === '/') return;
    const segs = n.split('/').filter(Boolean);
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      const existing = meta.get(cur);
      if (existing && existing.t === 'f') {
        throw new Error(`路径已是文件: ${cur}`);
      }
      if (!meta.has(cur)) meta.set(cur, null);
    }
  }

  /** 确保文件路径的父目录链存在(对齐 fs.write 自动 mkdir) */
  function ensureParentDirs(filePath) {
    const segs = norm(filePath).split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      const existing = meta.get(cur);
      if (existing && existing.t === 'f') throw new Error(`路径已是文件: ${cur}`);
      if (!meta.has(cur)) meta.set(cur, null);
    }
  }

  /** 直接子名;非目录 → null(对齐 fs.list) */
  function childNames(dirPath) {
    const n = norm(dirPath);
    if (!meta.has(n)) return null;
    const node = meta.get(n);
    if (node && node.t === 'f') return null;
    const prefix = n === '/' ? '/' : n + '/';
    const names = new Set();
    for (const key of meta.keys()) {
      if (key === n || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split('/')[0];
      if (first) names.add(first);
    }
    return [...names].sort();
  }

  return {
    kind: 'mock-webos-fs',
    /** 测试钩子:置 true 后 write 抛错(模拟配额/权限失败) */
    failWrites: false,

    normPath: norm,

    exists(p) {
      return meta.has(norm(p));
    },

    isDir(p) {
      const n = norm(p);
      return meta.has(n) && meta.get(n) === null;
    },

    isFile(p) {
      const n = norm(p);
      const m = meta.get(n);
      return !!m && m.t === 'f';
    },

    /** 递归建目录(对齐 fs.mkdir) */
    mkdir(p) {
      const n = norm(p);
      if (n !== '/' && meta.has(n) && meta.get(n)?.t === 'f') return null;
      const segs = n.split('/').filter(Boolean);
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        const existing = meta.get(cur);
        if (existing && existing.t === 'f') return null;
        if (!meta.has(cur)) meta.set(cur, null);
      }
      return true;
    },

    /** 读文件;不存在或为目录 → null(对齐 fs.read) */
    read(p /*, opts */) {
      const n = norm(p);
      const m = meta.get(n);
      if (!m || m.t !== 'f') return null;
      return contents.has(n) ? contents.get(n) : null;
    },

    /**
     * 写文件(自动建父目录)。
     * 内容只进 contents(= fsdata),元数据节点不携带 d —— 对齐 webos。
     */
    write(p, content, opts = {}) {
      void opts;
      if (this.failWrites) {
        const err = new Error('storage write failed');
        err.name = 'QuotaExceededError';
        throw err;
      }
      const n = norm(p);
      if (!n || n === '/') return false;
      // 目录节点为 null;文件为 {t:'f'}
      if (meta.has(n) && meta.get(n) === null) return false;
      const existing = meta.get(n);
      if (existing && existing.t === 'd') return false;
      try {
        ensureParentDirs(n);
      } catch {
        return false;
      }
      if (!meta.has(n) || meta.get(n)?.t !== 'f') {
        meta.set(n, { t: 'f', m: Date.now(), o: 'root', p: 'rw-r--' });
      }
      contents.set(n, String(content));
      return true;
    },

    /** 删文件;目录返回 false(简化) */
    rm(p) {
      const n = norm(p);
      const m = meta.get(n);
      if (!m || m.t !== 'f') return false;
      meta.delete(n);
      contents.delete(n);
      return true;
    },

    /** 列目录首层名;不存在目录 → null(对齐 fs.list) */
    list(p) {
      const names = childNames(p);
      return names;
    },

    /* ---------- 测试辅助:对齐 inode 拆分断言 ---------- */

    /** 元数据树(无文件内容)—— 概念上 = OPFS fs.v2.json */
    dumpMeta() {
      const out = {};
      for (const [path, m] of [...meta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (path === '/') continue;
        out[path] = m === null ? { t: 'd' } : { ...m };
      }
      return out;
    },

    /** 全部内容 —— 概念上 = OPFS fsdata/* */
    dumpContents() {
      return Object.fromEntries([...contents.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },

    /** 调试:全部文件绝对路径 */
    allFiles() {
      return [...contents.keys()].sort();
    },

    /** 调试:全部目录绝对路径 */
    allDirs() {
      return [...meta.entries()]
        .filter(([, m]) => m === null)
        .map(([p]) => p)
        .sort();
    },
  };
}

export default createMockWebosFs;
