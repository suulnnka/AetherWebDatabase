/* ============================================================
 * 存储适配 —— 同步 key/value 字符串接口
 *
 * 「数据库文件」在此抽象为一条持久化记录:
 *   getItem(key) → string | null
 *   setItem(key, string)
 *   removeItem(key)
 *
 * 浏览器默认 localStorage;测试/嵌入可注入 memoryStorage 或自定义适配。
 * 写入抛错(配额满等)由上层原子写捕获并回滚内存态。
 * ============================================================ */

/** 内存适配(测试 / 临时库),可注入 setItem 失败钩子做原子性测试 */
export function memoryStorage(init = {}) {
  const map = new Map(Object.entries(init));
  const storage = {
    /** 测试钩子:置 true 时 setItem 抛错 */
    failWrites: false,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (storage.failWrites) {
        const err = new Error('storage write failed');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    /** 快照全部键值(断言用) */
    dump() {
      return Object.fromEntries(map);
    },
  };
  return storage;
}

/** localStorage 适配(浏览器 / webos 默认) */
export function localAdapter() {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage 不可用,请显式传入 storage');
  }
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  };
}

/** 按 name 缓存的默认适配(同一 storage 单例,保证同 key 写串行可见) */
const defaults = new Map();
export function defaultStorage() {
  if (!defaults.has('ls')) defaults.set('ls', localAdapter());
  return defaults.get('ls');
}

/** 存储键:awdb.<name> —— 与 webos.* 键空间隔离 */
export const storageKey = (name) => `awdb.${name}`;
