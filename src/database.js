/* ============================================================
 * Database / Collection —— 文件型文档库核心
 *
 * 模型:
 *   一个「数据库文件」= 存储里的一条 key(awdb.<name>),
 *   内容为整库 JSON(可选整库 AES-GCM 加密)。
 *   库内多个集合(collection),集合 = id → 文档 的字典。
 *
 * 并发模型(刻意简化):
 *   · 同名库句柄唯一(open 单例)—— 同一文件天然单线程;
 *   · 所有操作进入该库的 Promise 队列串行执行(含异步加密写盘);
 *   · 不同库互不阻塞。
 *
 * 原子性:
 *   · 仅保证「单条指令」原子:先备份整库 JSON → 同步变更 →
 *     序列化+加密+落盘;任一步失败则内存回滚到备份。
 *   · 无跨语句事务、无视图(需求边界)。
 * ============================================================ */

import { encryptText, decryptText, isEncrypted } from './crypto.js';
import { defaultStorage, storageKey } from './storage.js';

const FORMAT_VERSION = 1;

/* ---------- 小工具 ---------- */

const clone = (x) => structuredClone(x);

/** 部分匹配:filter 为函数或平面对象(键全等,值深比较) */
function match(doc, filter) {
  if (filter == null) return true;
  if (typeof filter === 'function') return !!filter(doc);
  return Object.keys(filter).every((k) => deepEq(doc[k], filter[k]));
}

function deepEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

function emptyData() {
  return { v: FORMAT_VERSION, cols: {} };
}

function colOf(data, name) {
  let c = data.cols[name];
  if (!c) c = (data.cols[name] = { seq: 0, docs: {} });
  return c;
}

function ensureDocShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('文档必须是普通对象');
  }
}

/** patch 中去掉 id(id 不可经 patch 修改) */
function stripId(patch) {
  const { id: _id, ...rest } = patch;
  return rest;
}

/* ---------- 集合 ---------- */

export class Collection {
  #db;
  #name;

  constructor(db, name) {
    this.#db = db;
    this.#name = name;
  }

  get name() {
    return this.#name;
  }

  /** 插入一条;doc.id 已存在则抛错。返回带 id 的副本。 */
  insert(doc) {
    return this.#db._run(() => {
      ensureDocShape(doc);
      return this.#db._commit((data) => {
        const col = colOf(data, this.#name);
        const d = clone(doc);
        if (d.id == null) {
          col.seq += 1;
          d.id = `c${col.seq.toString(36)}-${Date.now().toString(36)}`;
        } else {
          d.id = String(d.id);
          if (col.docs[d.id]) throw new Error(`id 已存在: ${d.id}`);
        }
        col.docs[d.id] = d;
        return clone(d);
      });
    });
  }

  /** 批量插入(同一指令内全部成功或全部回滚) */
  insertMany(docs) {
    return this.#db._run(() => {
      if (!Array.isArray(docs)) throw new Error('insertMany 需要数组');
      docs.forEach(ensureDocShape);
      return this.#db._commit((data) => {
        const col = colOf(data, this.#name);
        const pending = [];
        const seen = new Set();
        for (const doc of docs) {
          const d = clone(doc);
          if (d.id == null) {
            col.seq += 1;
            d.id = `c${col.seq.toString(36)}-${Date.now().toString(36)}`;
          } else {
            d.id = String(d.id);
          }
          if (seen.has(d.id) || col.docs[d.id]) throw new Error(`id 已存在: ${d.id}`);
          seen.add(d.id);
          pending.push(d);
        }
        for (const d of pending) col.docs[d.id] = d;
        return pending.map(clone);
      });
    });
  }

  /** 按 id 取;不存在 → null */
  get(id) {
    return this.#db._run(() => {
      const col = this.#db._peek().cols[this.#name];
      const d = col && col.docs[String(id)];
      return d ? clone(d) : null;
    });
  }

  /**
   * 查询。
   * @param filter 函数或平面对象(默认全量)
   * @param opts   { sort: 'field' | { field: 1|-1 } | 1 | -1, limit, offset }
   */
  find(filter = null, opts = {}) {
    return this.#db._run(() => {
      const col = this.#db._peek().cols[this.#name];
      if (!col) return [];
      let list = Object.values(col.docs).filter((d) => match(d, filter)).map(clone);

      if (opts.sort != null) {
        let field;
        let desc = false;
        if (typeof opts.sort === 'string') field = opts.sort;
        else if (opts.sort === -1 || opts.sort === 1) desc = opts.sort === -1;
        else if (typeof opts.sort === 'object' && opts.sort) {
          field = Object.keys(opts.sort)[0];
          desc = opts.sort[field] === -1;
        } else field = String(opts.sort);

        if (field) {
          list.sort((a, b) => {
            const x = a[field];
            const y = b[field];
            if (x === y) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            const c = x < y ? -1 : x > y ? 1 : 0;
            return desc ? -c : c;
          });
        }
      }

      const offset = Math.max(0, opts.offset | 0);
      const limit = opts.limit == null ? -1 : Math.max(0, opts.limit | 0);
      if (offset || limit >= 0) {
        list = list.slice(offset, limit >= 0 ? offset + limit : undefined);
      }
      return list;
    });
  }

  /** 第一条匹配;无 → null */
  findOne(filter = null) {
    return this.#db._run(() => {
      const col = this.#db._peek().cols[this.#name];
      if (!col) return null;
      for (const d of Object.values(col.docs)) {
        if (match(d, filter)) return clone(d);
      }
      return null;
    });
  }

  /** 计数(可带 filter) */
  count(filter = null) {
    return this.#db._run(() => {
      const col = this.#db._peek().cols[this.#name];
      if (!col) return 0;
      if (filter == null) return Object.keys(col.docs).length;
      return Object.values(col.docs).filter((d) => match(d, filter)).length;
    });
  }

  /**
   * 按 id 浅合并 patch;不存在 → null。返回更新后副本。
   * id 不可经 patch 修改。
   */
  update(id, patch) {
    return this.#db._run(() => {
      ensureDocShape(patch);
      return this.#db._commit((data) => {
        const col = data.cols[this.#name];
        const key = String(id);
        const cur = col && col.docs[key];
        if (!cur) return null;
        const next = { ...cur, ...clone(stripId(patch)), id: key };
        col.docs[key] = next;
        return clone(next);
      });
    });
  }

  /** 按 filter 浅合并;返回更新条数 */
  updateWhere(filter, patch) {
    return this.#db._run(() => {
      ensureDocShape(patch);
      return this.#db._commit((data) => {
        const col = data.cols[this.#name];
        if (!col) return 0;
        const rest = clone(stripId(patch));
        let n = 0;
        for (const [key, cur] of Object.entries(col.docs)) {
          if (!match(cur, filter)) continue;
          col.docs[key] = { ...cur, ...rest, id: key };
          n++;
        }
        return n;
      });
    });
  }

  /** 按 id 删除;存在 → true */
  remove(id) {
    return this.#db._run(() =>
      this.#db._commit((data) => {
        const col = data.cols[this.#name];
        const key = String(id);
        if (!col || !col.docs[key]) return false;
        delete col.docs[key];
        return true;
      }),
    );
  }

  /** 按 filter 删除;返回删除条数 */
  removeWhere(filter) {
    return this.#db._run(() =>
      this.#db._commit((data) => {
        const col = data.cols[this.#name];
        if (!col) return 0;
        let n = 0;
        for (const [key, doc] of Object.entries(col.docs)) {
          if (match(doc, filter)) {
            delete col.docs[key];
            n++;
          }
        }
        return n;
      }),
    );
  }

  /** 清空集合(保留集合壳,seq 归零) */
  clear() {
    return this.#db._run(() =>
      this.#db._commit((data) => {
        const col = data.cols[this.#name];
        if (!col) return 0;
        const n = Object.keys(col.docs).length;
        col.docs = {};
        col.seq = 0;
        return n;
      }),
    );
  }
}

/* ---------- 数据库 ---------- */

export class Database {
  #name;
  #storage;
  #password;
  #key;
  #queue = Promise.resolve();
  #closed = false;
  /** 整库内存态 */
  _data = emptyData();

  constructor(name, { storage, password = null } = {}) {
    this.#name = name;
    this.#storage = storage;
    this.#password = password;
    this.#key = storageKey(name);
  }

  get name() {
    return this.#name;
  }

  get encrypted() {
    return this.#password != null;
  }

  get closed() {
    return this.#closed;
  }

  /** 当前密码(open 命中单例时做一致性检查) */
  _currentPassword() {
    return this.#password;
  }

  /** 集合句柄(轻量;首次写入时才建集合壳) */
  collection(name) {
    if (!name || typeof name !== 'string') throw new Error('集合名必须是非空字符串');
    if (this.#closed) throw new Error('数据库已关闭');
    return new Collection(this, name);
  }

  /** 列出已有集合名 */
  listCollections() {
    return this._run(() => Object.keys(this._data.cols).sort());
  }

  /** 删除整个集合 */
  dropCollection(name) {
    return this._run(() =>
      this._commit((data) => {
        if (!data.cols[name]) return false;
        delete data.cols[name];
        return true;
      }),
    );
  }

  /**
   * 换密:plain → 加密 / 加密换密码 / 解密去掉密码。
   * @param {string|null} newPassword null 表示改为明文存储
   */
  setPassword(newPassword) {
    return this._run(async () => {
      this.#password = newPassword ?? null;
      await this.#persist();
      return true;
    });
  }

  /** 导出整库 JSON 字符串(始终明文,与是否加密存储无关) */
  exportJSON() {
    return this._run(() => JSON.stringify(this._data));
  }

  /**
   * 导入整库(覆盖当前内容)。schema 须含 v / cols。
   * 落盘是否加密取决于当前 password。
   */
  importJSON(json) {
    return this._run(async () => {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || parsed.v !== FORMAT_VERSION
        || typeof parsed.cols !== 'object' || parsed.cols == null) {
        throw new Error('无效的库导出格式');
      }
      const snapshot = JSON.stringify(this._data);
      this._data = parsed;
      try {
        await this.#persist();
      } catch (e) {
        this._data = JSON.parse(snapshot);
        throw e;
      }
      return true;
    });
  }

  /** 删除库文件并关闭句柄;后续 open 得到空库 */
  drop() {
    return this._run(() => {
      this._data = emptyData();
      this.#storage.removeItem(this.#key);
      this.#closed = true;
      return true;
    });
  }

  /** 关闭句柄(不删文件);同名 open 可再次打开 */
  close() {
    this.#closed = true;
  }

  /* ---- 内部:队列 / 原子写 / 落盘 / 初始化 ---- */

  _assertOpen() {
    if (this.#closed) throw new Error('数据库已关闭');
  }

  /** 只读窥视(须在 _run 队列内) */
  _peek() {
    return this._data;
  }

  /**
   * 串行队列:同一库全部操作排队;单次失败不影响后续入队。
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  _run(fn) {
    const run = this.#queue.then(
      () => {
        this._assertOpen();
        return fn();
      },
      () => {
        this._assertOpen();
        return fn();
      },
    );
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * 单条指令原子提交:mutator 同步改 _data,随后落盘;
   * 落盘失败 → 内存回滚到变更前快照。
   * 须在 _run 队列内调用。
   * @template T
   * @param {(data: object) => T} mutator
   * @returns {Promise<T>}
   */
  async _commit(mutator) {
    const snapshot = JSON.stringify(this._data);
    let result;
    try {
      result = mutator(this._data);
      await this.#persist();
    } catch (e) {
      this._data = JSON.parse(snapshot);
      throw e;
    }
    return result;
  }

  async #persist() {
    const json = JSON.stringify(this._data);
    const payload = this.#password != null
      ? await encryptText(json, this.#password)
      : json;
    this.#storage.setItem(this.#key, payload);
  }

  /**
   * open 初始化专用:装载原始内容 / 建新库 / 明文升级加密。
   * 不进公开队列(open 的 pend 已防并发)。
   */
  static async _bootstrap(name, storage, password) {
    const key = storageKey(name);
    const raw = storage.getItem(key);
    const db = new Database(name, { storage, password: null });

    if (raw == null || raw === '') {
      db._data = emptyData();
      if (password) {
        db.#password = password;
        await db.#persist();
      }
      return db;
    }

    if (isEncrypted(raw)) {
      if (!password) throw new Error(`数据库已加密,需要密码: ${name}`);
      db._data = JSON.parse(await decryptText(raw, password));
      db.#password = password;
      return db;
    }

    db._data = JSON.parse(raw);
    if (password) {
      db.#password = password;
      await db.#persist(); // 明文 → 加密升级
    }
    return db;
  }
}

/* ---------- 打开(单例句柄) ---------- */

/** storage → (name → 活跃句柄)。用 Map 而非 WeakMap:closeAll 要能遍历。 */
const registry = new Map();
/** storage → (name → 打开中的 Promise) */
const opening = new WeakMap();

function mapFor(bucket, storage) {
  let m = bucket.get(storage);
  if (!m) {
    m = new Map();
    bucket.set(storage, m);
  }
  return m;
}

/**
 * 打开(或创建)数据库文件,返回句柄。
 * 同 storage + 同 name 并发 open 返回同一实例(同文件单线程)。
 *
 * @param {string} name  库名(存储键 awdb.<name>)
 * @param {object} [opts]
 * @param {string} [opts.password]  加密密码;已有明文库传密码会自动升级为加密
 * @param {object} [opts.storage]   存储适配;默认 localStorage
 * @returns {Promise<Database>}
 */
export async function open(name, opts = {}) {
  if (!name || typeof name !== 'string') throw new Error('库名必须是非空字符串');
  const storage = opts.storage || defaultStorage();
  let reg = registry.get(storage);
  if (!reg) {
    reg = new Map();
    registry.set(storage, reg);
  }
  const pend = mapFor(opening, storage);

  const hit = reg.get(name);
  if (hit && !hit.closed) {
    if (opts.password) {
      const cur = hit._currentPassword();
      if (cur == null) await hit.setPassword(opts.password);
      else if (cur !== opts.password) {
        throw new Error(`数据库已用其他密码打开: ${name}`);
      }
    }
    return hit;
  }

  const existing = pend.get(name);
  if (existing) return existing;

  const task = Database._bootstrap(name, storage, opts.password ?? null).then((db) => {
    reg.set(name, db);
    return db;
  });
  // 失败的 open 不留句柄
  const guarded = task.catch((e) => {
    pend.delete(name);
    throw e;
  });
  pend.set(name, guarded);
  try {
    return await guarded;
  } finally {
    pend.delete(name);
  }
}

/** 关闭全部句柄(测试 / 重置用);不删文件 */
export function closeAll() {
  for (const m of registry.values()) {
    for (const db of m.values()) db.close();
    m.clear();
  }
}

export default { open, Database, Collection, closeAll };
