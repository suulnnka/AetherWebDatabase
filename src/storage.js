/* ============================================================
 * 后端 —— 按页读写的可插拔存储
 *
 *   openBackend(name, kind)
 *     kind: 'opfs'(默认,浏览器) | 'memory'(测试) | 自定义 {readPage,writePages,...}
 *
 * 字符串 kind 按 `kind:name` 缓存后端实例,保证同文件单例。
 * 自定义对象原样透传(注册表以对象引用为键)。
 * ============================================================ */

import { PAGE_SIZE } from './page.js';

/** 字符串后端缓存: `memory:foo` / `opfs:bar` → backend */
const backendCache = new Map();

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

/* ---------- OPFS ---------- */

const DIR = 'awdb';

async function opfsRoot() {
  if (!globalThis.navigator?.storage?.getDirectory) {
    throw new Error('当前环境不支持 OPFS;测试请传 storage: createMemoryBackend() 或 "memory"');
  }
  return navigator.storage.getDirectory();
}

export async function createOpfsBackend(name) {
  const root = await opfsRoot();
  const dir = await root.getDirectoryHandle(DIR, { create: true });
  const fh = await dir.getFileHandle(`${name}.awdb`, { create: true });

  return {
    kind: 'opfs',
    async readPage(no) {
      const file = await fh.getFile();
      const start = no * PAGE_SIZE;
      const buf = await file.slice(start, start + PAGE_SIZE).arrayBuffer();
      const out = new Uint8Array(PAGE_SIZE);
      out.set(new Uint8Array(buf));
      return out;
    },
    async writePages(startNo, chunks) {
      const w = await fh.createWritable({ keepExistingData: true });
      try {
        for (let i = 0; i < chunks.length; i++) {
          const buf = new Uint8Array(PAGE_SIZE);
          buf.set(chunks[i].subarray(0, PAGE_SIZE));
          await w.write((startNo + i) * PAGE_SIZE, buf);
        }
      } finally {
        await w.close();
      }
    },
    async pageCount() {
      const file = await fh.getFile();
      return Math.ceil(file.size / PAGE_SIZE);
    },
    async close() {},
  };
}

/**
 * 解析后端。
 * @param {string} name
 * @param {object|string} storage 'opfs'|'memory'|自定义后端|工厂函数
 */
export async function openBackend(name, storage) {
  if (storage && typeof storage === 'object' && typeof storage.readPage === 'function') {
    return storage;
  }
  if (typeof storage === 'function') return storage(name);

  const kind = storage == null ? 'opfs' : String(storage);
  if (kind !== 'opfs' && kind !== 'memory') {
    throw new Error(`未知 storage 后端: ${kind}`);
  }
  const key = `${kind}:${name}`;
  if (backendCache.has(key)) return backendCache.get(key);

  const be = kind === 'memory'
    ? createMemoryBackend()
    : await createOpfsBackend(name);
  backendCache.set(key, be);
  return be;
}

/** 测试辅助:清掉字符串后端缓存 */
export function resetBackendCache() {
  backendCache.clear();
}

export const memoryStorage = createMemoryBackend;
