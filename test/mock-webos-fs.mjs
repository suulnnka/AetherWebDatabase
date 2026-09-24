/* ============================================================
 * 模拟 webos 虚拟文件系统(Node 测试用)
 *
 * API 对齐 js/core/fs.js 的最小子集:
 *   read(path, opts?) / write(path, content, opts?) / exists / isDir / mkdir
 * 路径为绝对路径字符串;无权限模型(测试不关心鉴权)。
 *
 * 用法:
 *   import { createMockWebosFs } from './mock-webos-fs.mjs';
 *   const fs = createMockWebosFs();
 *   const backend = createFileBackend(fs, '/home/u/appdata/sms.awdb');
 * ============================================================ */

export function createMockWebosFs() {
  /** @type {Map<string, string>} 路径 → 文件内容 */
  const files = new Map();
  /** @type {Set<string>} 目录路径 */
  const dirs = new Set(['/', '/home']);

  function norm(p) {
    const out = [];
    for (const seg of String(p || '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  }

  function parentOf(p) {
    const segs = norm(p).split('/').filter(Boolean);
    segs.pop();
    return '/' + segs.join('/');
  }

  /** 确保从根到 path 的目录都存在(文件路径的父链) */
  function ensureDirs(filePath) {
    const segs = norm(filePath).split('/').filter(Boolean);
    segs.pop(); // 最后一段是文件名
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      dirs.add(cur);
    }
  }

  return {
    kind: 'mock-webos-fs',
    files,
    dirs,
    /** 测试钩子:置 true 后 write 抛错(模拟配额/权限失败) */
    failWrites: false,

    normPath: norm,

    exists(p) {
      const n = norm(p);
      return files.has(n) || dirs.has(n);
    },

    isDir(p) {
      return dirs.has(norm(p));
    },

    mkdir(p) {
      const n = norm(p);
      const segs = n.split('/').filter(Boolean);
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        dirs.add(cur);
      }
      return true;
    },

    /** 读文件;不存在 → null(对齐 webos fs.read) */
    read(p /*, opts */) {
      const n = norm(p);
      return files.has(n) ? files.get(n) : null;
    },

    /** 写文件(自动建父目录);返回 boolean */
    write(p, content, opts = {}) {
      void opts;
      if (this.failWrites) {
        const err = new Error('storage write failed');
        err.name = 'QuotaExceededError';
        throw err;
      }
      const n = norm(p);
      if (!n || n === '/') return false;
      ensureDirs(n);
      files.set(n, String(content));
      return true;
    },

    rm(p) {
      return files.delete(norm(p));
    },

    list(p) {
      const n = norm(p);
      if (!dirs.has(n)) return null;
      const prefix = n === '/' ? '/' : n + '/';
      const names = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first) names.add(first);
        }
      }
      for (const d of dirs) {
        if (d !== n && d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first) names.add(first);
        }
      }
      return [...names].sort();
    },

    /** 调试:全部文件路径 */
    allFiles() {
      return [...files.keys()].sort();
    },
  };
}

export default createMockWebosFs;
