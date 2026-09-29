/* ============================================================
 * Database / Collection —— 分页文档库(不直连 OPFS)
 *
 * 模型:
 *   · 一个库 = 一个 `.awdb` 文件,固定 4096B 页(注入后端承载);
 *   · page0/1 双超级块(CRC + generation),写脏页后翻转另一槽 → 单指令原子;
 *   · 目录 JSON(free + cols)存连续数据页;文档 UTF-8 字节按 chunk 分片;
 *   · 可选页级 AES-GCM(密钥 open 时 PBKDF2 一次并缓存);
 *   · 同名库句柄单例 + 每库 Promise 队列;无视图、无跨语句事务。
 * ============================================================ */

import {
  PAGE_SIZE,
  CHUNK_ENC,
  CHUNK_PLAIN,
  FIRST_DATA_PAGE,
  SUPER_A,
  SUPER_B,
  encodeSuper,
  pickSuper,
  decodeSuper,
  pagesNeeded,
} from './page.js';
import { deriveKey, randomSalt, encryptPage, decryptPage } from './crypto.js';
import { openBackend } from './storage.js';
import {
  normalizeSchema,
  checkDoc,
  checkRequired,
  applyDefaults,
  stripUnknown,
  absorbDoc,
} from './schema.js';
import { runSql } from './sql.js';

const te = new TextEncoder();
const td = new TextDecoder();

const clone = (x) => structuredClone(x);

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
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

function ensureDocShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('文档必须是普通对象');
}

function stripId(patch) {
  const { id: _id, ...rest } = patch;
  return rest;
}

function emptyCatalog() {
  return { free: [], cols: {} };
}

/** find/count 共用的排序 + 分页(对内存数组就地处理) */
function applySortPage(list, opts) {
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
  if (offset || limit >= 0) return list.slice(offset, limit >= 0 ? offset + limit : undefined);
  return list;
}

function padPlain(logical) {
  const page = new Uint8Array(PAGE_SIZE);
  if (logical.length > PAGE_SIZE) throw new Error('逻辑页超出 PAGE_SIZE');
  page.set(logical);
  return page;
}

function slotOf(page0, page1) {
  const a = decodeSuper(page0);
  const b = decodeSuper(page1);
  if (a && b) return a.generation >= b.generation ? SUPER_A : SUPER_B;
  if (a) return SUPER_A;
  if (b) return SUPER_B;
  return null;
}

/* ---------- 写事务 ---------- */

class Txn {
  constructor(db) {
    this.db = db;
    this.catalogJson = JSON.stringify(db._cat);
    /** 页号 → 逻辑载荷 */
    this.dirty = new Map();
    this.extendedTo = db._pageCount;
  }

  get cat() {
    return this.db._cat;
  }

  alloc(n) {
    const out = [];
    const cat = this.cat;
    while (out.length < n) {
      if (cat.free.length) out.push(cat.free.pop());
      else out.push(this.extendedTo++);
    }
    return out;
  }

  free(pages) {
    for (const p of pages) {
      if (p >= FIRST_DATA_PAGE) this.cat.free.push(p);
    }
  }

  setDirty(pageNo, logical) {
    this.dirty.set(pageNo, logical);
  }

  rollback() {
    this.db._cat = JSON.parse(this.catalogJson);
    this.dirty.clear();
  }
}

/* ---------- Collection ---------- */

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

  #col(create = false) {
    const cat = this.#db._cat;
    let c = cat.cols[this.#name];
    if (!c && create) c = (cat.cols[this.#name] = { seq: 0, docs: {} });
    return c;
  }

  #storeDoc(txn, bytes) {
    const chunk = this.#db._chunk;
    const need = pagesNeeded(bytes.length, chunk);
    const pages = txn.alloc(need);
    for (let i = 0; i < need; i++) {
      const start = i * chunk;
      txn.setDirty(pages[i], bytes.subarray(start, start + chunk));
    }
    return { p: pages, n: bytes.length };
  }

  #freeDoc(txn, meta) {
    if (meta?.p) txn.free(meta.p);
  }

  async #readDoc(meta) {
    const bytes = await this.#db._readBytes(meta);
    return JSON.parse(td.decode(bytes));
  }

  /** 写入口 schema 管线:strict 校验 / auto 吸收(随本次事务落盘)+ 补默认值 + 必填检查 */
  #schemaPass(col, doc) {
    const sc = col.schema;
    if (!sc) return;
    if (sc.mode === 'auto') {
      const errs = absorbDoc(doc, sc);
      if (errs.length) throw new Error(`schema 校验失败(${this.#name}): ${errs.join('; ')}`);
      applyDefaults(doc, sc);
      const rerrs = checkRequired(doc, sc);
      if (rerrs.length) throw new Error(`schema 校验失败(${this.#name}): ${rerrs.join('; ')}`);
    } else {
      const errs = checkDoc(doc, sc);
      if (errs.length) throw new Error(`schema 校验失败(${this.#name}): ${errs.join('; ')}`);
      if (sc.extra === 'strip') stripUnknown(doc, sc);
      applyDefaults(doc, sc);
    }
  }

  /** 本集合发生写入 → 物化缓存失效(SQL/物化路径下次重建) */
  #invalidate() {
    this.#db._mat.delete(this.#name);
  }

  /**
   * 整集合物化为内存数组(SQL 查询的数据源)。
   * 只读场景缓存永久有效;写入该集合即失效。返回数组为库内部对象,
   * 调用方只读使用(修改请走 update 系列)。
   */
  loadAll() {
    return this.#db._read(async () => {
      if (this.#db._mat.has(this.#name)) return this.#db._mat.get(this.#name);
      const col = this.#col(false);
      const out = [];
      if (col) {
        for (const meta of Object.values(col.docs)) out.push(await this.#readDoc(meta));
      }
      this.#db._mat.set(this.#name, out);
      return out;
    });
  }

  #nextId(col, explicit) {
    if (explicit != null) return String(explicit);
    col.seq += 1;
    return `c${col.seq.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  insert(doc) {
    return this.#db._write(async () => {
      ensureDocShape(doc);
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(true);
        const d = clone(doc);
        d.id = this.#nextId(col, d.id);
        if (col.docs[d.id]) throw new Error(`id 已存在: ${d.id}`);
        this.#schemaPass(col, d);
        const bytes = te.encode(JSON.stringify(d));
        col.docs[d.id] = this.#storeDoc(txn, bytes);
        await this.#db._commit(txn);
        this.#invalidate();
        return clone(d);
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  insertMany(docs) {
    return this.#db._write(async () => {
      if (!Array.isArray(docs)) throw new Error('insertMany 需要数组');
      docs.forEach(ensureDocShape);
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(true);
        const pending = [];
        const seen = new Set();
        for (const d of docs) {
          const dd = clone(d);
          dd.id = this.#nextId(col, dd.id);
          if (seen.has(dd.id) || col.docs[dd.id]) throw new Error(`id 已存在: ${dd.id}`);
          seen.add(dd.id);
          this.#schemaPass(col, dd);
          pending.push(dd);
        }
        for (const d of pending) {
          col.docs[d.id] = this.#storeDoc(txn, te.encode(JSON.stringify(d)));
        }
        await this.#db._commit(txn);
        this.#invalidate();
        return pending.map(clone);
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  get(id) {
    return this.#db._read(async () => {
      const col = this.#col(false);
      const meta = col?.docs[String(id)];
      if (!meta) return null;
      return this.#readDoc(meta);
    });
  }

  find(filter = null, opts = {}) {
    return this.#db._read(async () => {
      const col = this.#col(false);
      if (!col) return [];
      let list;
      if (this.#db._mat.has(this.#name)) {
        const mat = this.#db._mat.get(this.#name);
        list = filter == null ? [...mat] : mat.filter((d) => match(d, filter));
      } else {
        list = [];
        for (const meta of Object.values(col.docs)) {
          const doc = await this.#readDoc(meta);
          if (match(doc, filter)) list.push(doc);
        }
      }
      list = applySortPage(list, opts);
      /* 页路径每次 find 都重新 JSON.parse(天然独立);物化路径共享内部对象,须深拷贝 */
      return list.map(clone);
    });
  }

  findOne(filter = null) {
    return this.#db._read(async () => {
      const col = this.#col(false);
      if (!col) return null;
      if (this.#db._mat.has(this.#name)) {
        const hit = this.#db._mat.get(this.#name).find((d) => match(d, filter));
        return hit ? clone(hit) : null;
      }
      for (const meta of Object.values(col.docs)) {
        const doc = await this.#readDoc(meta);
        if (match(doc, filter)) return doc;
      }
      return null;
    });
  }

  count(filter = null) {
    return this.#db._read(async () => {
      const col = this.#col(false);
      if (!col) return 0;
      if (filter == null) return Object.keys(col.docs).length;
      if (this.#db._mat.has(this.#name)) {
        return this.#db._mat.get(this.#name).reduce((n, d) => (match(d, filter) ? n + 1 : n), 0);
      }
      let n = 0;
      for (const meta of Object.values(col.docs)) {
        if (match(await this.#readDoc(meta), filter)) n++;
      }
      return n;
    });
  }

  update(id, patch) {
    return this.#db._write(async () => {
      ensureDocShape(patch);
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        const key = String(id);
        const oldMeta = col?.docs[key];
        if (!oldMeta) {
          txn.rollback();
          return null;
        }
        const cur = await this.#readDoc(oldMeta);
        const next = { ...cur, ...clone(stripId(patch)), id: key };
        this.#schemaPass(col, next);
        this.#freeDoc(txn, oldMeta);
        col.docs[key] = this.#storeDoc(txn, te.encode(JSON.stringify(next)));
        await this.#db._commit(txn);
        this.#invalidate();
        return next;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  updateWhere(filter, patch) {
    return this.#db._write(async () => {
      ensureDocShape(patch);
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        if (!col) {
          txn.rollback();
          return 0;
        }
        const rest = clone(stripId(patch));
        const rewrites = [];
        for (const [key, meta] of Object.entries(col.docs)) {
          const cur = await this.#readDoc(meta);
          if (match(cur, filter)) {
            const next = { ...cur, ...rest, id: key };
            this.#schemaPass(col, next);
            rewrites.push({ key, meta, next });
          }
        }
        if (!rewrites.length) {
          txn.rollback();
          return 0;
        }
        for (const { key, meta, next } of rewrites) {
          this.#freeDoc(txn, meta);
          col.docs[key] = this.#storeDoc(txn, te.encode(JSON.stringify(next)));
        }
        await this.#db._commit(txn);
        this.#invalidate();
        return rewrites.length;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  remove(id) {
    return this.#db._write(async () => {
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        const key = String(id);
        const meta = col?.docs[key];
        if (!meta) {
          txn.rollback();
          return false;
        }
        this.#freeDoc(txn, meta);
        delete col.docs[key];
        await this.#db._commit(txn);
        this.#invalidate();
        return true;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  removeWhere(filter) {
    return this.#db._write(async () => {
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        if (!col) {
          txn.rollback();
          return 0;
        }
        const kills = [];
        for (const [key, meta] of Object.entries(col.docs)) {
          if (match(await this.#readDoc(meta), filter)) kills.push({ key, meta });
        }
        if (!kills.length) {
          txn.rollback();
          return 0;
        }
        for (const { key, meta } of kills) {
          this.#freeDoc(txn, meta);
          delete col.docs[key];
        }
        await this.#db._commit(txn);
        this.#invalidate();
        return kills.length;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  clear() {
    return this.#db._write(async () => {
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        if (!col) {
          txn.rollback();
          return 0;
        }
        const n = Object.keys(col.docs).length;
        for (const meta of Object.values(col.docs)) this.#freeDoc(txn, meta);
        col.docs = {};
        col.seq = 0;
        await this.#db._commit(txn);
        this.#invalidate();
        return n;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  /* ---- schema ---- */

  /**
   * 替换集合 schema(宽松变更,等价 ALTER TABLE):
   * strict 模式默认先扫描存量文档校验(不一致即报错回滚,传 scan:false 跳过);
   * auto 模式不扫(演化式,存量不动)。fields 传 null 可移除 schema。
   */
  setSchema(fields, opts = {}) {
    return this.#db._write(async () => {
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        if (!col) throw new Error(`集合不存在: ${this.#name}`);
        const sc = fields == null ? null : normalizeSchema(fields, opts);
        let scanned = 0;
        if (sc && sc.mode !== 'auto' && opts.scan !== false) {
          for (const [key, meta] of Object.entries(col.docs)) {
            const doc = JSON.parse(td.decode(await this.#db._readBytes(meta)));
            const errs = checkDoc(doc, sc);
            if (errs.length) throw new Error(`文档 ${key} 不符合新 schema: ${errs.join('; ')}`);
            scanned++;
          }
        }
        if (sc) col.schema = sc;
        else delete col.schema;
        await this.#db._commit(txn);
        return scanned;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  /**
   * 迁移 schema(破坏性变更):单事务内重读全集合 → run(doc) 逐文档变换 →
   * 按新 schema 严格校验 → 全量重写落盘(等价 setPassword 的紧凑重写机制)。
   * run 不得改 id;version 记入集合元数据 schemaV。
   */
  migrateSchema({ fields, mode, extra, version, run }) {
    return this.#db._write(async () => {
      const txn = new Txn(this.#db);
      try {
        const col = this.#col(false);
        if (!col) throw new Error(`集合不存在: ${this.#name}`);
        const sc = normalizeSchema(fields ?? {}, { mode, extra });
        const rewrites = [];
        for (const [key, meta] of Object.entries(col.docs)) {
          const cur = await this.#readDoc(meta);
          const next = run ? await run(clone(cur)) : clone(cur);
          ensureDocShape(next);
          next.id = key;
          const errs = checkDoc(next, sc);
          if (errs.length) throw new Error(`迁移后文档 ${key} 不符合新 schema: ${errs.join('; ')}`);
          applyDefaults(next, sc);
          rewrites.push({ key, meta, next });
        }
        for (const { key, meta, next } of rewrites) {
          this.#freeDoc(txn, meta);
          col.docs[key] = this.#storeDoc(txn, te.encode(JSON.stringify(next)));
        }
        col.schema = sc;
        if (version != null) col.schemaV = version;
        await this.#db._commit(txn);
        this.#invalidate();
        return rewrites.length;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }
}

/* ---------- Database ---------- */

export class Database {
  #name;
  #backend;
  #password;
  #key = null;
  #salt = null;
  #queue = Promise.resolve();
  #closed = false;

  _super = null;
  _lastSlot = null;
  _cat = emptyCatalog();
  _pageCount = 2;
  _chunk = CHUNK_PLAIN;
  /** 读缓存:页号 → 逻辑页(提交后清空) */
  _pageCache = new Map();
  /** 集合物化缓存:集合名 → 文档数组(SQL 查询源;写该集合即失效) */
  _mat = new Map();

  constructor(name, init = {}) {
    this.#name = name;
    this.#backend = init.backend;
    this.#password = init.password ?? null;
    this._super = init.super ?? null;
    this._cat = init.catalog ?? emptyCatalog();
    this.#key = init.key ?? null;
    this.#salt = init.salt ?? new Uint8Array(16);
    this._chunk = init.chunk ?? CHUNK_PLAIN;
    this._pageCount = init.pageCount ?? FIRST_DATA_PAGE;
    this._lastSlot = init.lastSlot ?? null;
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

  _currentPassword() {
    return this.#password;
  }

  collection(name) {
    if (!name || typeof name !== 'string') throw new Error('集合名必须是非空字符串');
    if (this.#closed) throw new Error('数据库已关闭');
    return new Collection(this, name);
  }

  /**
   * 建集合(幂等):不存在则建空集合并落盘,已存在则仅在传入 schema 时更新之。
   * opts:{ schema?: 字段声明, mode?: 'strict'|'auto', extra?: 'reject'|'allow'|'strip' }
   */
  async createCollection(name, opts = {}) {
    return this._write(async () => {
      if (!name || typeof name !== 'string') throw new Error('集合名必须是非空字符串');
      this._assertOpen();
      const txn = new Txn(this);
      try {
        let col = this._cat.cols[name];
        if (!col) col = this._cat.cols[name] = { seq: 0, docs: {} };
        if (opts.schema != null || opts.mode != null || opts.extra != null) {
          col.schema = normalizeSchema(opts.schema ?? {}, opts);
        }
        await this._commit(txn);
        return this.collection(name);
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  /**
   * SQL 查询(只读 SELECT;数据经集合物化,首次查询触发 loadAll)。
   * @param {string} text SQL 文本(? 为占位参数)
   * @param {Array} [params] 参数按序绑定
   */
  sql(text, params = []) {
    return runSql(this, text, params);
  }

  listCollections() {
    return this._read(() => Object.keys(this._cat.cols).sort());
  }

  dropCollection(name) {
    return this._write(async () => {
      const txn = new Txn(this);
      try {
        const col = this._cat.cols[name];
        if (!col) {
          txn.rollback();
          return false;
        }
        for (const meta of Object.values(col.docs)) this.#freeMeta(txn, meta);
        delete this._cat.cols[name];
        this._mat.delete(name);
        await this._commit(txn);
        return true;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  #freeMeta(txn, meta) {
    if (meta?.p) txn.free(meta.p);
  }

  /**
   * 换密:null → 明文;否则 AES。
   * 紧凑重写全部文档 + 目录页(等价于全库导出再导入)。
   */
  setPassword(newPassword) {
    return this._write(async () => {
      const txn = new Txn(this);
      try {
        // 1) 备份集合壳 + 读出全部文档明文字节
        const colNames = Object.keys(this._cat.cols);
        const seqOf = {};
        const docsPlain = [];
        for (const cname of colNames) {
          const col = this._cat.cols[cname];
          seqOf[cname] = col.seq;
          for (const [id, meta] of Object.entries(col.docs)) {
            docsPlain.push({ cname, id, bytes: await this._readBytes(meta) });
          }
        }

        // 2) 切换密钥 / chunk
        const pass = newPassword ?? null;
        if (pass != null) {
          this.#salt = randomSalt();
          this.#key = await deriveKey(pass, this.#salt);
          this._chunk = CHUNK_ENC;
        } else {
          this.#salt = new Uint8Array(16);
          this.#key = null;
          this._chunk = CHUNK_PLAIN;
        }
        this.#password = pass;

        // 3) 紧凑重写:free 清空,页从 FIRST_DATA 重排
        this._cat = emptyCatalog();
        txn.dirty.clear();
        let cursor = FIRST_DATA_PAGE;
        const place = (bytes) => {
          const need = pagesNeeded(bytes.length, this._chunk);
          const pages = [];
          for (let i = 0; i < need; i++) {
            const start = i * this._chunk;
            pages.push(cursor);
            txn.setDirty(cursor, bytes.subarray(start, start + this._chunk));
            cursor++;
          }
          return pages;
        };

        for (const cname of colNames) {
          this._cat.cols[cname] = { seq: seqOf[cname] ?? 0, docs: {} };
        }
        for (const { cname, id, bytes } of docsPlain) {
          this._cat.cols[cname].docs[id] = { p: place(bytes), n: bytes.length };
        }

        // 4) 目录页
        const catBytes = te.encode(JSON.stringify(this._cat));
        const catPages = place(catBytes);
        const catalogStart = catPages[0];

        await this._commitLayout(txn, {
          catalogStart,
          catalogPages: catPages.length,
          catalogByteLen: catBytes.length,
          pageCount: cursor,
        });
        this._pageCache.clear();
        this._mat.clear();
        return true;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  /** 导出:目录 + 全部文档明文(与是否页加密无关) */
  exportJSON() {
    return this._read(async () => {
      const out = { v: 1, cols: {} };
      for (const [cname, col] of Object.entries(this._cat.cols)) {
        const docs = {};
        for (const [id, meta] of Object.entries(col.docs)) {
          docs[id] = JSON.parse(td.decode(await this._readBytes(meta)));
        }
        out.cols[cname] = { seq: col.seq, docs };
      }
      return JSON.stringify(out);
    });
  }

  /** 导入:覆盖全部集合(文档重新落页);格式须含 cols */
  importJSON(json) {
    return this._write(async () => {
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error('无效的库导出格式');
      }
      if (!parsed || typeof parsed !== 'object' || parsed.v !== 1
        || !parsed.cols || typeof parsed.cols !== 'object') {
        throw new Error('无效的库导出格式');
      }
      const txn = new Txn(this);
      try {
        // 释放旧文档页
        for (const col of Object.values(this._cat.cols)) {
          for (const meta of Object.values(col.docs)) this.#freeMeta(txn, meta);
        }
        this._cat = emptyCatalog();
        const store = (bytes) => {
          const need = pagesNeeded(bytes.length, this._chunk);
          const pages = txn.alloc(need);
          for (let i = 0; i < need; i++) {
            const start = i * this._chunk;
            txn.setDirty(pages[i], bytes.subarray(start, start + this._chunk));
          }
          return { p: pages, n: bytes.length };
        };
        for (const [cname, col] of Object.entries(parsed.cols)) {
          const docsIn = col?.docs && typeof col.docs === 'object' ? col.docs : {};
          const shell = { seq: col?.seq ?? 0, docs: {} };
          this._cat.cols[cname] = shell;
          for (const [id, doc] of Object.entries(docsIn)) {
            if (!doc || typeof doc !== 'object') continue;
            const bytes = te.encode(JSON.stringify({ ...doc, id }));
            shell.docs[id] = store(bytes);
          }
        }
        await this._commit(txn);
        this._mat.clear();
        return true;
      } catch (e) {
        txn.rollback();
        throw e;
      }
    });
  }

  /** 删除库:写入空明文库并关闭(清除加密态) */
  drop() {
    return this._write(async () => {
      // 读出空壳,强制转明文紧凑重建
      this.#password = null;
      this.#key = null;
      this.#salt = new Uint8Array(16);
      this._chunk = CHUNK_PLAIN;
      this._cat = emptyCatalog();
      this._pageCache.clear();

      const txn = new Txn(this);
      const catBytes = te.encode(JSON.stringify(this._cat));
      const need = pagesNeeded(catBytes.length, this._chunk);
      let cursor = FIRST_DATA_PAGE;
      for (let i = 0; i < need; i++) {
        txn.setDirty(cursor, catBytes.subarray(i * this._chunk, (i + 1) * this._chunk));
        cursor++;
      }
      await this._commitLayout(txn, {
        catalogStart: FIRST_DATA_PAGE,
        catalogPages: need,
        catalogByteLen: catBytes.length,
        pageCount: cursor,
      });
      this._pageCache.clear();
      this._mat.clear();
      this.#closed = true;
      return true;
    });
  }

  close() {
    this.#closed = true;
  }

  /* ---- 队列 ---- */

  _assertOpen() {
    if (this.#closed) throw new Error('数据库已关闭');
  }

  _read(fn) {
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

  _write(fn) {
    return this._read(fn);
  }

  /* ---- 读 ---- */

  async _loadLogical(pageNo) {
    if (this._pageCache.has(pageNo)) return this._pageCache.get(pageNo);
    const raw = await this.#backend.readPage(pageNo);
    let logical;
    if (this.#password != null) {
      logical = await decryptPage(raw, this.#key, this._chunk);
    } else {
      logical = raw;
    }
    this._pageCache.set(pageNo, logical);
    return logical;
  }

  async _readBytes(meta) {
    const out = new Uint8Array(meta.n);
    let off = 0;
    for (let i = 0; i < meta.p.length && off < meta.n; i++) {
      const logical = await this._loadLogical(meta.p[i]);
      const take = Math.min(meta.n - off, logical.length);
      out.set(logical.subarray(0, take), off);
      off += take;
    }
    if (off < meta.n) throw new Error('数据页缺失或损坏');
    return out;
  }

  async _loadCatalog(sb) {
    const parts = [];
    let remain = sb.catalogByteLen;
    for (let i = 0; i < sb.catalogPages && remain > 0; i++) {
      const raw = await this.#backend.readPage(sb.catalogStart + i);
      let logical;
      if (sb.encrypted) logical = await decryptPage(raw, this.#key, CHUNK_ENC);
      else logical = raw;
      const take = Math.min(remain, logical.length);
      parts.push(logical.subarray(0, take));
      remain -= take;
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    return td.decode(buf);
  }

  /* ---- 提交 ---- */

  async _commit(txn) {
    const catBytes = te.encode(JSON.stringify(this._cat));
    const need = pagesNeeded(catBytes.length, this._chunk);
    const pages = txn.alloc(need);
    for (let i = 0; i < need; i++) {
      const start = i * this._chunk;
      txn.setDirty(pages[i], catBytes.subarray(start, start + this._chunk));
    }
    let pageCount = txn.extendedTo;
    for (const p of txn.dirty.keys()) pageCount = Math.max(pageCount, p + 1);
    await this._commitLayout(txn, {
      catalogStart: pages[0],
      catalogPages: need,
      catalogByteLen: catBytes.length,
      pageCount,
    });
    this._pageCache.clear();
  }

  /**
   * 写脏页 + 新超级块(另一槽)。失败时不写超级块 → 旧 generation 仍有效。
   */
  async _commitLayout(txn, { catalogStart, catalogPages, catalogByteLen, pageCount }) {
    const enc = this.#password != null;

    // 1) 逻辑页 → 落盘页
    const encoded = new Map();
    for (const [no, logical] of txn.dirty) {
      encoded.set(no, enc ? await encryptPage(logical, this.#key, this._chunk) : padPlain(logical));
    }

    // 2) 连续段聚合写
    const nos = [...encoded.keys()].sort((a, b) => a - b);
    let i = 0;
    while (i < nos.length) {
      const start = nos[i];
      let j = i;
      const chunks = [encoded.get(start)];
      while (j + 1 < nos.length && nos[j + 1] === nos[j] + 1) {
        j++;
        chunks.push(encoded.get(nos[j]));
      }
      await this.#backend.writePages(start, chunks);
      i = j + 1;
    }

    // 3) 超级块翻到另一槽
    const prevSlot = this._lastSlot;
    const nextSlot = prevSlot === SUPER_A ? SUPER_B : SUPER_A;
    const generation = this._super ? ((this._super.generation + 1) >>> 0) || 1 : 1;
    const sb = {
      version: 1,
      pageSize: PAGE_SIZE,
      chunkSize: this._chunk,
      generation,
      encrypted: enc ? 1 : 0,
      salt: this.#salt,
      catalogStart,
      catalogPages,
      catalogByteLen,
      pageCount,
    };
    await this.#backend.writePages(nextSlot, [encodeSuper(sb)]);

    this._super = sb;
    this._lastSlot = nextSlot;
    this._pageCount = pageCount;
  }

  /* ---- bootstrap ---- */

  static async _bootstrap(name, backend, password) {
    const page0 = await backend.readPage(SUPER_A);
    const page1 = await backend.readPage(SUPER_B);
    const sb = pickSuper(page0, page1);
    const lastSlot = slotOf(page0, page1);

    if (!sb) {
      const enc = password != null;
      const salt = enc ? randomSalt() : new Uint8Array(16);
      const key = enc ? await deriveKey(password, salt) : null;
      const chunk = enc ? CHUNK_ENC : CHUNK_PLAIN;
      const db = new Database(name, {
        backend,
        password,
        key,
        salt,
        super: null,
        catalog: emptyCatalog(),
        chunk,
        pageCount: FIRST_DATA_PAGE,
        lastSlot: null,
      });
      const txn = new Txn(db);
      const catBytes = te.encode(JSON.stringify(db._cat));
      const need = pagesNeeded(catBytes.length, chunk);
      let cursor = FIRST_DATA_PAGE;
      for (let i = 0; i < need; i++) {
        txn.setDirty(cursor, catBytes.subarray(i * chunk, (i + 1) * chunk));
        cursor++;
      }
      await db._commitLayout(txn, {
        catalogStart: FIRST_DATA_PAGE,
        catalogPages: need,
        catalogByteLen: catBytes.length,
        pageCount: cursor,
      });
      db._pageCache.clear();
      return db;
    }

    const enc = !!sb.encrypted;
    let key = null;
    if (enc) {
      if (!password) throw new Error(`数据库已加密,需要密码: ${name}`);
      key = await deriveKey(password, sb.salt);
    }
    const chunk = enc ? CHUNK_ENC : (sb.chunkSize || CHUNK_PLAIN);
    const db = new Database(name, {
      backend,
      password: enc ? password : null,
      key,
      salt: sb.salt,
      super: sb,
      catalog: emptyCatalog(),
      chunk,
      pageCount: sb.pageCount,
      lastSlot,
    });
    const json = await db._loadCatalog(sb);
    db._cat = JSON.parse(json);
    if (!db._cat.cols) db._cat.cols = {};
    if (!Array.isArray(db._cat.free)) db._cat.free = [];
    return db;
  }
}

/* ============================================================
 * open 单例
 * ============================================================ */

const registry = new Map();
const opening = new WeakMap();

function mapFor(bucket, key) {
  let m = bucket.get(key);
  if (!m) {
    m = new Map();
    bucket.set(key, m);
  }
  return m;
}

/**
 * 打开分页数据库。
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.password]
 * @param {object|string} [opts.storage] 自定义后端 | 'memory'(默认)| 工厂函数;
 *   **禁止隐式 OPFS** —— 浏览器/宿主须注入 createFileBackend 或自定义后端
 */
export async function open(name, opts = {}) {
  if (!name || typeof name !== 'string') throw new Error('库名必须是非空字符串');
  const storage = opts.storage ?? 'memory';
  const backend = await openBackend(name, storage);
  // 自定义对象 / memory 函数每次可能新实例:用 storage 引用或字符串作注册键
  const regKey = typeof storage === 'object' && storage !== null ? storage : `${String(storage)}:${name}`;
  // 字符串 storage 时按 backend 实例更稳:
  const bucketKey = (typeof storage === 'string' || typeof storage === 'function')
    ? backend
    : (typeof storage === 'object' && storage !== null && storage.readPage ? storage : backend);

  let reg = registry.get(bucketKey);
  if (!reg) {
    reg = new Map();
    registry.set(bucketKey, reg);
  }
  const pend = mapFor(opening, bucketKey);
  void regKey;

  const hit = reg.get(name);
  if (hit && !hit.closed) {
    if (opts.password) {
      const cur = hit._currentPassword();
      if (cur == null) await hit.setPassword(opts.password);
      else if (cur !== opts.password) throw new Error(`数据库已用其他密码打开: ${name}`);
    }
    return hit;
  }

  const existing = pend.get(name);
  if (existing) return existing;

  const task = Database._bootstrap(name, backend, opts.password ?? null).then(async (db) => {
    // 已有明文库 + 传入密码 → 升级为页级加密
    if (opts.password && !db.encrypted) {
      await db.setPassword(opts.password);
    }
    reg.set(name, db);
    return db;
  });
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

export function closeAll() {
  for (const m of registry.values()) {
    for (const db of m.values()) db.close();
    m.clear();
  }
}

export default { open, Database, Collection, closeAll };
