/* ============================================================
 * 后端 —— 按页读写的可插拔存储
 *
 * 库本身**不直连 OPFS**。调用方必须注入后端:
 *   · createMemoryBackend()     内存(单元测试)
 *   · createFileBackend(fs, p)  字节文件(VFS / 模拟 FS / 宿主注入)
 *   · 自定义 { readPage, writePages, pageCount }
 *
 * open() 未传 storage 时默认 memory(避免误走浏览器私有存储)。
 * ============================================================ */

import { PAGE_SIZE } from './page.js';

/** 字符串 kind 缓存: 仅 memory:name */
const backendCache = new Map();

/**
 * 旧格式标记(仅**读取兼容**;新写入不再 base64 包装)。
 * 形如 `AWDBVFS1:<base64(整库字节)>`。
 */
export const FILE_MAGIC = 'AWDBVFS1:';

/* ---------- 内存后端 ---------- */

export function createMemoryBackend() {
  /** @type {Uint8Array[]} */
  let pages = [];

  return {
    kind: 'memory',
    /** 测试钩子:置 true 后 writePages 抛错 */
    failWrites: false,
    async readPage(no) {
      if (no < 0 || no >= pages.length) return new Uint8Array(PAGE_SIZE);
      return pages[no].slice();
    },
    async writePages(startNo, chunks) {
      if (this.failWrites) {
        const err = new Error('storage write failed');
        err.name = 'QuotaExceededError';
        throw err;
      }
      for (let i = 0; i < chunks.length; i++) {
        const no = startNo + i;
        while (pages.length <= no) pages.push(new Uint8Array(PAGE_SIZE));
        const dst = pages[no];
        dst.fill(0);
        dst.set(chunks[i].subarray(0, PAGE_SIZE));
      }
    },
    async pageCount() {
      return pages.length;
    },
    async close() {},
    dump() {
      return pages.map((p) => p.slice());
    },
  };
}

/* ---------- 字节文件后端(VFS / 模拟 FS / OPFS 经宿主注入) ---------- */

/**
 * @typedef {object} ByteFileFs
 * @property {(path: string, opts?: object) => string|null} [read]
 * @property {(path: string, content: string, opts?: object) => boolean} [write]
 * @property {(path: string, opts?: object) => Uint8Array|null} [readBinary]
 * @property {(path: string, data: Uint8Array, opts?: object) => boolean} [writeBinary]
 */

const u8ToB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * 把分页库存成**二进制文件**(不再 base64 包一层)。
 * 优先 `readBinary`/`writeBinary`;否则退回字符串 read/write,
 * 并兼容旧格式 `FILE_MAGIC + base64`。
 *
 * @param {ByteFileFs} fsLike
 * @param {string} path  建议带 .awdb 扩展名
 * @param {object} [opts] 透传给 fs 的选项(如 { as: user })
 */
export function createFileBackend(fsLike, path, opts = {}) {
  if (!fsLike || (typeof fsLike.writeBinary !== 'function' && typeof fsLike.write !== 'function')) {
    throw new Error('createFileBackend 需要 writeBinary 或 write');
  }
  if (!path || typeof path !== 'string') throw new Error('createFileBackend 需要文件路径');

  let buf = null;

  function loadBytes() {
    if (typeof fsLike.readBinary === 'function') {
      const b = fsLike.readBinary(path, opts);
      if (b instanceof Uint8Array) return b;
    }
    if (typeof fsLike.read === 'function') {
      const raw = fsLike.read(path, opts);
      // 旧格式:AWDBVFS1:<base64>
      if (raw && typeof raw === 'string' && raw.startsWith(FILE_MAGIC)) {
        try {
          return b64ToU8(raw.slice(FILE_MAGIC.length));
        } catch {
          return new Uint8Array(0);
        }
      }
    }
    return new Uint8Array(0);
  }

  async function ensureLoaded() {
    if (buf) return;
    buf = loadBytes();
  }

  /** 把候选缓冲写入文件;成功后由调用方提交 buf */
  async function flushTo(bytes) {
    if (!bytes) return;
    let ok = false;
    if (typeof fsLike.writeBinary === 'function') {
      ok = fsLike.writeBinary(path, bytes, opts);
    } else if (typeof fsLike.write === 'function') {
      // 仅字符串 FS:仍用旧包装(宿主应优先实现 writeBinary)
      ok = fsLike.write(path, FILE_MAGIC + u8ToB64(bytes), opts);
    }
    if (!ok) {
      const err = new Error(`写入失败: ${path}`);
      err.name = 'QuotaExceededError';
      throw err;
    }
  }

  return {
    kind: 'file',
    path,
    async readPage(no) {
      await ensureLoaded();
      const off = no * PAGE_SIZE;
      const out = new Uint8Array(PAGE_SIZE);
      if (off < buf.length) {
        out.set(buf.subarray(off, Math.min(off + PAGE_SIZE, buf.length)));
      }
      return out;
    },
    async writePages(startNo, chunks) {
      await ensureLoaded();
      // 在副本上改,flush 成功才提交到 buf —— 失败不污染已提交页(CoW 依赖)
      const need = (startNo + chunks.length) * PAGE_SIZE;
      const next = need > buf.length ? new Uint8Array(need) : buf.slice();
      if (need > buf.length) next.set(buf);
      applyChunks(next, startNo, chunks);
      await flushTo(next);
      buf = next;
    },
    async pageCount() {
      await ensureLoaded();
      return Math.ceil(buf.length / PAGE_SIZE) || 0;
    },
    async close() {},
  };
}

function applyChunks(target, startNo, chunks) {
  for (let i = 0; i < chunks.length; i++) {
    const off = (startNo + i) * PAGE_SIZE;
    target.fill(0, off, off + PAGE_SIZE);
    target.set(chunks[i].subarray(0, PAGE_SIZE), off);
  }
}

/**
 * 解析后端。
 * @param {string} name
 * @param {object|string} [storage] 自定义后端 | 'memory'(默认)| 工厂函数
 */
export async function openBackend(name, storage) {
  if (storage && typeof storage === 'object' && typeof storage.readPage === 'function') {
    return storage;
  }
  if (typeof storage === 'function') return storage(name);

  const kind = storage == null ? 'memory' : String(storage);
  if (kind !== 'memory') {
    throw new Error(
      `未知 storage: ${kind}。库不直连 OPFS;请注入 createFileBackend / createMemoryBackend 或自定义 {readPage,writePages}`,
    );
  }
  const key = `memory:${name}`;
  if (backendCache.has(key)) return backendCache.get(key);
  const be = createMemoryBackend();
  backendCache.set(key, be);
  return be;
}

/** 测试辅助:清掉字符串后端缓存 */
export function resetBackendCache() {
  backendCache.clear();
}

export const memoryStorage = createMemoryBackend;
