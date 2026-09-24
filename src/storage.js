/* ============================================================
 * 后端 —— 按页读写的可插拔存储
 *
 * 库本身**不直连 OPFS**。调用方必须注入后端:
 *   · createMemoryBackend()     内存(单元测试)
 *   · createFileBackend(fs, p)  字符串文件(VFS / 模拟 FS)
 *   · 自定义 { readPage, writePages, pageCount }
 *
 * open() 未传 storage 时默认 memory(避免误走浏览器私有存储)。
 * ============================================================ */

import { PAGE_SIZE } from './page.js';

/** 字符串 kind 缓存: 仅 memory:name */
const backendCache = new Map();

/** 整库落进字符串文件的魔数前缀(与 webos appdata 一致) */
export const FILE_MAGIC = 'AWDBVFS1:';

const u8ToB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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

/* ---------- 字符串文件后端(VFS / 模拟 FS) ---------- */

/**
 * @typedef {object} StringFileFs
 * @property {(path: string, opts?: object) => string|null} read
 * @property {(path: string, content: string, opts?: object) => boolean} write
 */

/**
 * 把分页库存成字符串文件:`FILE_MAGIC + base64(整库字节)`。
 * 读时整文件进内存,按页号切片;写时整文件回写——与 webos VFS 一致,
 * 不依赖 OPFS 字节偏移。
 *
 * @param {StringFileFs} fsLike  至少 read/write
 * @param {string} path          文件路径(建议带 .awdb 扩展名)
 * @param {object} [opts]        透传给 fs.read/write 的选项(如 { as: user })
 */
export function createFileBackend(fsLike, path, opts = {}) {
  if (!fsLike || typeof fsLike.read !== 'function' || typeof fsLike.write !== 'function') {
    throw new Error('createFileBackend 需要 { read, write } 文件系统适配');
  }
  if (!path || typeof path !== 'string') throw new Error('createFileBackend 需要文件路径');

  let buf = null;

  async function ensureLoaded() {
    if (buf) return;
    const raw = fsLike.read(path, opts);
    if (raw && raw.startsWith(FILE_MAGIC)) {
      try {
        buf = b64ToU8(raw.slice(FILE_MAGIC.length));
      } catch {
        buf = new Uint8Array(0);
      }
    } else {
      buf = new Uint8Array(0);
    }
  }

  /** 把候选缓冲写入文件;成功后由调用方提交 buf */
  async function flushTo(bytes) {
    if (!bytes) return;
    const ok = fsLike.write(path, FILE_MAGIC + u8ToB64(bytes), opts);
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
