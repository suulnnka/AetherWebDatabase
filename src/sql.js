/* ============================================================
 * SQL —— 只读 SELECT 查询前端(零依赖,物化内存执行)
 *
 * 定位:大表只读检索;数据经 Collection.loadAll() 物化(首次查询
 * 触发,写该集合即失效)。无 DML / DDL / 跨语句事务。
 *
 * 支持:
 *   SELECT [DISTINCT] 项 [AS 别名] FROM 表 [别名]
 *     [INNER|LEFT [OUTER]] JOIN … ON 等值(可 AND 多键)
 *     [WHERE …] [GROUP BY …] [HAVING …]
 *     [ORDER BY … [ASC|DESC], …] [LIMIT n [OFFSET m]]
 *   表达式:比较 / AND / OR / NOT / IN(列表|子查询)/ BETWEEN /
 *     LIKE / IS [NOT] NULL / MATCH(空白分词全命中,免索引扫描)/
 *     CASE [值] WHEN … THEN … [ELSE …] END(简单式/搜索式)/
 *     + - * / % / ||(拼接)/ ? 参数
 *   聚合:COUNT(*|x|DISTINCT x) / SUM / AVG / MIN / MAX + GROUP BY + HAVING
 *   标量函数:LOWER UPPER LENGTH ABS ROUND COALESCE INSTR
 *   ORDER BY 文本键按拼音序(Intl.Collator 'zh');等值/join/分组仍精确值
 *   子查询:
 *     · FROM 派生表(非相关)
 *     · 非相关 IN / EXISTS / 标量子查询(执行一次缓存)
 *     · 等值相关 EXISTS / IN / 标量聚合 —— hash 化为 Set/Map,不逐行重跑
 *   嵌套限制:相关子查询的关联列必须带**直接外层**表的别名前缀;
 *     非等值相关、相关子查询内 JOIN、LATERAL 明确报不支持。
 *
 * 执行模型:AST → 编译为 JS 闭包(不用 new Function,CSP 安全),
 * 谓词遵循 SQL 三值逻辑(NULL 参与 → null,过滤条件须 === true)。
 * 行 = 文档数组(下标 = 别名序,join 逐层 concat 追加),闭包编译时捕获
 * 别名下标,免每行 spread 复制累积属性。
 * join/IN/EXISTS/相关标量共享同一套 hash 原语(Map/Set + 探测)。
 * WHERE 合取项按下推执行:单源项在对应表进入时过滤(FROM 侧 / INNER
 * 新表侧),多源项在引用源齐备处过滤;聚合与相关子查询项留在 join 后。
 * LIMIT 无排序/去重/聚合时短路:只产出前 offset+limit 行(产出为稳定前缀,
 * 与全量产出后切片一致);ORDER BY + LIMIT 走 top-N 定长堆,免全量排序。
 * 单键等值 hash(join 桶 / 相关子查询)以原始值直接作 Map 键,免逐行
 * 拼规范串;对象键退 JSON 串并隔离存放,不与原始字符串撞键。
 * ============================================================ */

/* ---------- tokenizer ---------- */

const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER',
  'LIMIT', 'OFFSET', 'AS', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'ON',
  'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'TRUE',
  'FALSE', 'ASC', 'DESC', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'MATCH',
]);

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      toks.push(KEYWORDS.has(up) ? { k: 'kw', v: up, pos: start, end: j } : { k: 'id', v: word, pos: start, end: j });
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (src[j] === quote) {
          if (quote === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j];
        j++;
      }
      if (j >= n) throw new Error(`SQL 解析错误 @${start}: 未终止的 ${quote === "'" ? '字符串' : '标识符'}`);
      toks.push(quote === "'" ? { k: 'str', v: s, pos: start, end: j + 1 } : { k: 'id', v: s, pos: start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) { j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
      }
      toks.push({ k: 'num', v: parseFloat(src.slice(i, j)), pos: start, end: j });
      i = j;
      continue;
    }
    if (c === '?') { toks.push({ k: 'param', v: null, pos: start, end: start + 1 }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '||') {
      toks.push({ k: 'op', v: two === '<>' ? '!=' : two, pos: start, end: i + 2 });
      i += 2;
      continue;
    }
    if ('=<>+-*/%(),.'.includes(c)) { toks.push({ k: 'op', v: c, pos: start, end: i + 1 }); i++; continue; }
    throw new Error(`SQL 解析错误 @${start}: 无法识别的字符 '${c}'`);
  }
  toks.push({ k: 'eof', v: null, pos: n, end: n });
  return toks;
}

/* ---------- parser(递归下降) ---------- */

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.i = 0;
    this.paramCount = 0;
  }
  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  isKw(kw, o = 0) { const t = this.peek(o); return t.k === 'kw' && t.v === kw; }
  eatKw(kw) { if (this.isKw(kw)) { this.i++; return true; } return false; }
  expectKw(kw) { if (!this.eatKw(kw)) this.fail(`期望 ${kw}`); }
  isOp(v, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  eatOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  expectOp(v) { if (!this.eatOp(v)) this.fail(`期望 '${v}'`); }
  fail(msg) {
    const t = this.peek();
    const got = t.k === 'eof' ? '结尾' : `'${this.src.slice(t.pos, t.end)}'`;
    throw new Error(`SQL 解析错误 @${t.pos}: ${msg},得到 ${got}`);
  }

  parseQuery() {
    this.expectKw('SELECT');
    const distinct = this.eatKw('DISTINCT');
    const items = [this.parseSelectItem()];
    while (this.eatOp(',')) items.push(this.parseSelectItem());
    this.expectKw('FROM');
    const from = this.parseTableRef();
    const joins = [];
    while (this.isKw('JOIN') || this.isKw('INNER') || this.isKw('LEFT')) {
      let type = 'inner';
      if (this.eatKw('LEFT')) { this.eatKw('OUTER'); type = 'left'; }
      else this.eatKw('INNER');
      this.expectKw('JOIN');
      const ref = this.parseTableRef();
      this.expectKw('ON');
      const on = this.parseExpr();
      joins.push({ type, ref, on });
    }
    let where = null;
    if (this.eatKw('WHERE')) where = this.parseExpr();
    const groupBy = [];
    if (this.eatKw('GROUP')) {
      this.expectKw('BY');
      groupBy.push(this.parseExpr());
      while (this.eatOp(',')) groupBy.push(this.parseExpr());
    }
    let having = null;
    if (this.eatKw('HAVING')) having = this.parseExpr();
    const orderBy = [];
    if (this.eatKw('ORDER')) {
      this.expectKw('BY');
      for (;;) {
        const e = this.parseExpr();
        let desc = false;
        if (this.eatKw('DESC')) desc = true;
        else this.eatKw('ASC');
        orderBy.push({ e, desc });
        if (!this.eatOp(',')) break;
      }
    }
    let limit = null;
    let offset = null;
    if (this.eatKw('LIMIT')) {
      const t = this.next();
      if (t.k !== 'num') this.fail('LIMIT 需要数字');
      limit = t.v;
      if (this.eatKw('OFFSET')) {
        const t2 = this.next();
        if (t2.k !== 'num') this.fail('OFFSET 需要数字');
        offset = t2.v;
      }
    }
    return { distinct, items, from, joins, where, groupBy, having, orderBy, limit, offset };
  }

  parseSelectItem() {
    if (this.eatOp('*')) return { star: true, name: '*' };
    if (this.peek().k === 'id' && this.isOp('.', 1) && this.peek(2).k === 'op' && this.peek(2).v === '*') {
      const a = this.next().v;
      this.i += 2;
      return { star: a, name: `${a}.*` };
    }
    const start = this.peek().pos;
    const e = this.parseExpr();
    const endTok = this.toks[this.i - 1];
    let alias = null;
    if (this.eatKw('AS')) {
      const t = this.next();
      if (t.k !== 'id') this.fail('AS 后需要标识符');
      alias = t.v;
    } else if (this.peek().k === 'id') {
      alias = this.next().v;
    }
    const name = alias ?? (e.t === 'col' ? e.parts[e.parts.length - 1] : this.src.slice(start, endTok.end).trim());
    return { e, alias, name };
  }

  parseTableRef() {
    if (this.eatOp('(')) {
      if (!this.isKw('SELECT')) this.fail('括号表源需要 SELECT 子查询');
      const sub = this.parseQuery();
      this.expectOp(')');
      this.eatKw('AS');
      const t = this.next();
      if (t.k !== 'id') this.fail('派生表需要别名');
      return { name: null, sub, alias: t.v };
    }
    const t = this.next();
    if (t.k !== 'id') this.fail('期望表名');
    let alias = null;
    if (this.eatKw('AS')) {
      const a = this.next();
      if (a.k !== 'id') this.fail('AS 后需要标识符');
      alias = a.v;
    } else if (this.peek().k === 'id') {
      alias = this.next().v;
    }
    return { name: t.v, sub: null, alias: alias ?? t.v };
  }

  /* 表达式:OR < AND < NOT < 谓词 < 加减/拼接 < 乘除模 < 一元 < 原子 */
  parseExpr() { return this.parseOr(); }
  parseOr() {
    let l = this.parseAnd();
    while (this.eatKw('OR')) l = { t: 'bin', op: 'OR', l, r: this.parseAnd() };
    return l;
  }
  parseAnd() {
    let l = this.parseNot();
    while (this.eatKw('AND')) l = { t: 'bin', op: 'AND', l, r: this.parseNot() };
    return l;
  }
  parseNot() {
    if (this.eatKw('NOT')) return { t: 'not', e: this.parseNot() };
    return this.parsePredicate();
  }
  parsePredicate() {
    const e = this.parseAdditive();
    if (this.eatKw('IS')) {
      const not = this.eatKw('NOT');
      this.expectKw('NULL');
      return { t: 'isnull', e, not };
    }
    let not = false;
    if (this.isKw('NOT') && (this.isKw('IN', 1) || this.isKw('BETWEEN', 1) || this.isKw('LIKE', 1) || this.isKw('MATCH', 1))) {
      this.next();
      not = true;
    }
    if (this.eatKw('IN')) {
      this.expectOp('(');
      if (this.isKw('SELECT')) {
        const sub = this.parseQuery();
        this.expectOp(')');
        return { t: 'in', e, list: null, sub, not };
      }
      const list = [this.parseExpr()];
      while (this.eatOp(',')) list.push(this.parseExpr());
      this.expectOp(')');
      return { t: 'in', e, list, sub: null, not };
    }
    if (this.eatKw('BETWEEN')) {
      const lo = this.parseAdditive();
      this.expectKw('AND');
      const hi = this.parseAdditive();
      return { t: 'between', e, lo, hi, not };
    }
    if (this.eatKw('LIKE')) {
      const pat = this.parseAdditive();
      return { t: 'like', e, pat, not };
    }
    /* 全文匹配(免索引逐行扫):查询串按空白分词,全部词都出现才命中 */
    if (this.eatKw('MATCH')) {
      const pat = this.parseAdditive();
      return { t: 'match', e, pat, not };
    }
    const t = this.peek();
    if (t.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.i++;
      return { t: 'bin', op: t.v, l: e, r: this.parseAdditive() };
    }
    return e;
  }
  parseAdditive() {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '+' || t.v === '-' || t.v === '||')) {
        this.i++;
        l = { t: 'bin', op: t.v, l, r: this.parseMul() };
      } else return l;
    }
  }
  parseMul() {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        this.i++;
        l = { t: 'bin', op: t.v, l, r: this.parseUnary() };
      } else return l;
    }
  }
  parseUnary() {
    const t = this.peek();
    if (t.k === 'op' && t.v === '-') { this.i++; return { t: 'neg', e: this.parseUnary() }; }
    if (t.k === 'op' && t.v === '+') { this.i++; return this.parseUnary(); }
    return this.parseAtom();
  }
  parseAtom() {
    const t = this.peek();
    if (t.k === 'num' || t.k === 'str') { this.i++; return { t: 'lit', v: t.v }; }
    if (t.k === 'param') { this.i++; return { t: 'param', i: this.paramCount++ }; }
    if (t.k === 'kw' && t.v === 'NULL') { this.i++; return { t: 'lit', v: null }; }
    if (t.k === 'kw' && t.v === 'TRUE') { this.i++; return { t: 'lit', v: true }; }
    if (t.k === 'kw' && t.v === 'FALSE') { this.i++; return { t: 'lit', v: false }; }
    if (t.k === 'kw' && t.v === 'EXISTS') {
      this.i++;
      this.expectOp('(');
      if (!this.isKw('SELECT')) this.fail('EXISTS 后需要 SELECT 子查询');
      const q = this.parseQuery();
      this.expectOp(')');
      return { t: 'exists', q };
    }
    /* CASE [operand] WHEN … THEN … [WHEN …] [ELSE …] END:有无 operand 区分简单式/搜索式 */
    if (t.k === 'kw' && t.v === 'CASE') {
      this.i++;
      const operand = this.isKw('WHEN') ? null : this.parseExpr();
      const whens = [];
      while (this.eatKw('WHEN')) {
        const w = this.parseExpr();
        this.expectKw('THEN');
        whens.push({ w, r: this.parseExpr() });
      }
      if (!whens.length) this.fail('CASE 需要至少一个 WHEN');
      let els = null;
      if (this.eatKw('ELSE')) els = this.parseExpr();
      this.expectKw('END');
      return { t: 'case', operand, whens, els };
    }
    if (t.k === 'op' && t.v === '(') {
      this.i++;
      if (this.isKw('SELECT')) {
        const q = this.parseQuery();
        this.expectOp(')');
        return { t: 'sub', q };
      }
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    if (t.k === 'id') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const distinct = this.eatKw('DISTINCT');
        const args = [];
        let star = false;
        if (this.eatOp('*')) star = true;
        else if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.eatOp(',')) args.push(this.parseExpr());
        }
        this.expectOp(')');
        return { t: 'func', name: t.v.toUpperCase(), args, distinct, star };
      }
      const parts = [t.v];
      while (this.isOp('.') && this.peek(1).k === 'id') {
        this.i += 2;
        parts.push(this.toks[this.i - 1].v);
      }
      return { t: 'col', parts };
    }
    this.fail('期望表达式');
  }
}

export function parse(text) {
  const p = new Parser(text);
  const q = p.parseQuery();
  if (p.peek().k !== 'eof') p.fail('查询结束后还有多余内容');
  q.__paramCount = p.paramCount;
  return q;
}

/* ---------- 值语义(SQL 三值逻辑) ---------- */

const NULLROW = Object.freeze({});

const norm = (v) => (v === undefined ? null : v);

function typeRank(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return 1;
  if (typeof v === 'string') return 2;
  if (typeof v === 'boolean') return 3;
  return 4;
}

/** 全序比较(排序 / 等值判定;null 恒后,异型按类型序) */
function cmpVal(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const ta = typeRank(a);
  const tb = typeRank(b);
  if (ta !== tb) return ta - tb;
  if (ta === 1) return a - b;
  if (ta === 3) return (a ? 1 : 0) - (b ? 1 : 0);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function cmpOp(op, a, b) {
  if (a == null || b == null) return null;
  const c = cmpVal(a, b);
  if (op === '=') return c === 0;
  if (op === '!=') return c !== 0;
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  return c >= 0;
}

const not3 = (v) => (v == null ? null : !v);

function likeToRe(pat) {
  let re = '';
  for (const ch of pat) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '.';
    else re += /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
  }
  return new RegExp(`^${re}$`);
}

/* 排序键的文本比较:按查询指定的 collation(Intl.Collator locale,
 * 缺省 'zh' 拼音;空串=码点序)。仅用于 ORDER BY —— 等值/join/分组/
 * IN 仍按精确值,不受音序影响 */
const collCache = new Map();
function collOf(locale) {
  if (!locale) return null;
  if (!collCache.has(locale)) {
    try { collCache.set(locale, new Intl.Collator(locale)); }
    catch { collCache.set(locale, null); }   // 非法 locale 回落码点序
  }
  return collCache.get(locale);
}

/** 值 → 规范键(join 桶 / 分组 / IN 集合) */
function normKey(v) {
  if (v == null) return '\u0000';
  if (typeof v === 'number') return 'n:' + v;
  if (typeof v === 'boolean') return 'b:' + v;
  if (typeof v === 'string') return 's:' + v;
  try { return 'o:' + JSON.stringify(v); } catch { return 'o:' + String(v); }
}

/** join/相关匹配键:任一键 null → 不匹配(null 返回) */
function keyTuple(ks) {
  for (const k of ks) if (k == null) return null;
  return ks.length === 1 ? normKey(ks[0]) : JSON.stringify(ks.map(normKey));
}

/** 单键等值 hash(join 桶 / 相关子查询):原始值直接作键 —— 数字/字符串/
 *  布尔按 SameValueZero 天然分型(1 与 '1' 不混),免逐行拼规范串;对象无
 *  值语义,退 JSON 规范串并放独立 Map,原始字符串不可能与之撞键 */
class KeyMap {
  #prim = new Map();
  #obj = new Map();
  get(v) {
    return typeof v === 'object' ? this.#obj.get(normKey(v)) : this.#prim.get(v);
  }
  set(v, val) {
    if (typeof v === 'object') this.#obj.set(normKey(v), val);
    else this.#prim.set(v, val);
  }
  has(v) {
    return typeof v === 'object' ? this.#obj.has(normKey(v)) : this.#prim.has(v);
  }
  *values() {
    yield* this.#prim.values();
    yield* this.#obj.values();
  }
}

/** 行 = 文档数组(下标 = 别名在该 scope.sources 中的序,与 join 追加序
 *  一致);scope.idx 是别名→下标。闭包编译时捕获下标,免每行 spread 复制
 *  累积属性 */
const mkScope = (sources, outer = null) => ({ sources, outer, idx: new Map(sources.map((s, i) => [s, i])) });

/** 分组键:null 也可分组(不同于 join) */
function groupKey(ks) {
  return ks.length === 1 ? normKey(ks[0]) : JSON.stringify(ks.map(normKey));
}

function pathGet(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

function flattenAnd(e) {
  if (e?.t === 'bin' && e.op === 'AND') return [...flattenAnd(e.l), ...flattenAnd(e.r)];
  return [e];
}

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

/* ---------- Runtime:物化 + 编译 + 执行 ---------- */

class Runtime {
  constructor(db, params, opts = {}) {
    this.db = db;
    this.params = params;
    /** ORDER BY 文本键的排序 locale(undefined → 'zh' 拼音;'' → 码点序) */
    this.collation = opts.collation === undefined ? 'zh' : opts.collation;
    /** 集合名 → 物化行数组 */
    this.tables = new Map();
    /** 派生表 Query 节点 → 输出行数组 */
    this.derived = new Map();
    /** 子查询节点(对象身份)→ 缓存值(标量值 / Set / Map) */
    this.subCache = new Map();
  }

  cached(node, compute) {
    if (!this.subCache.has(node)) this.subCache.set(node, compute());
    return this.subCache.get(node);
  }

  async loadTable(name) {
    if (!this.tables.has(name)) {
      this.tables.set(name, await this.db.collection(name).loadAll());
    }
    return this.tables.get(name);
  }

  sourceRows(ref) {
    if (ref.sub) {
      const hit = this.derived.get(ref.sub);
      if (!hit) throw new Error('派生表未解析(内部错误)');
      return hit;
    }
    return this.tables.get(ref.name) ?? [];
  }

  /** 递归物化查询涉及的全部表 + 先行执行派生表(非相关,async) */
  async resolve(q) {
    await this.resolveRef(q.from);
    for (const j of q.joins) await this.resolveRef(j.ref);
    const walk = async (e) => {
      if (e == null) return;
      switch (e.t) {
        case 'bin': await walk(e.l); await walk(e.r); break;
        case 'not': case 'neg': await walk(e.e); break;
        case 'isnull': await walk(e.e); break;
        case 'in': await walk(e.e); for (const x of e.list ?? []) await walk(x); if (e.sub) await this.resolve(e.sub); break;
        case 'between': await walk(e.e); await walk(e.lo); await walk(e.hi); break;
        case 'like': await walk(e.e); await walk(e.pat); break;
        case 'match': await walk(e.e); await walk(e.pat); break;
        case 'case':
          if (e.operand != null) await walk(e.operand);
          for (const w of e.whens) { await walk(w.w); await walk(w.r); }
          if (e.els != null) await walk(e.els);
          break;
        case 'func': for (const a of e.args) await walk(a); break;
        case 'sub': case 'exists': await this.resolve(e.q); break;
        default: break;  // col / lit / param
      }
    };
    for (const it of q.items) if (it.e) await walk(it.e);
    if (q.where) await walk(q.where);
    if (q.having) await walk(q.having);
    for (const g of q.groupBy) await walk(g);
    for (const o of q.orderBy) await walk(o.e);
  }

  async resolveRef(ref) {
    if (ref.sub) {
      if (!this.derived.has(ref.sub)) {
        await this.resolve(ref.sub);
        this.derived.set(ref.sub, this.exec(ref.sub));
      }
      return;
    }
    await this.loadTable(ref.name);
  }

  /* ---------- 表达式编译:AST → 闭包 ---------- */

  /**
   * @param {object} e 表达式 AST
   * @param {{sources: string[], outer: object|null}} scope
   * @param {object} [opts] { strict?: boolean } —— strict 下未限定列报错(相关子查询外层键用)
   * @returns {{fn: Function, refs: Set, hasAgg: boolean, wild: boolean}}
   */
  compileExpr(e, scope, opts = {}) {
    switch (e.t) {
      case 'col': return this.compileCol(e, scope, opts);
      case 'lit': {
        const v = e.v;
        return { fn: () => v, refs: new Set(), hasAgg: false, wild: false };
      }
      case 'param': {
        if (e.i >= this.params.length) throw new Error(`缺少第 ${e.i + 1} 个 ? 参数`);
        const v = this.params[e.i];
        return { fn: () => v, refs: new Set(), hasAgg: false, wild: false };
      }
      case 'bin': return this.compileBin(e, scope, opts);
      case 'not': {
        const C = this.compileExpr(e.e, scope, opts);
        return { fn: (r, g, o, or) => not3(C.fn(r, g, o, or)), refs: C.refs, hasAgg: C.hasAgg, wild: C.wild };
      }
      case 'neg': {
        const C = this.compileExpr(e.e, scope, opts);
        return {
          fn: (r, g, o, or) => { const v = C.fn(r, g, o, or); return typeof v === 'number' ? -v : null; },
          refs: C.refs, hasAgg: C.hasAgg, wild: C.wild,
        };
      }
      case 'isnull': {
        const C = this.compileExpr(e.e, scope, opts);
        return {
          fn: (r, g, o, or) => { const v = C.fn(r, g, o, or); return e.not ? v != null : v == null; },
          refs: C.refs, hasAgg: C.hasAgg, wild: C.wild,
        };
      }
      case 'between': {
        const C = this.compileExpr(e.e, scope, opts);
        const L = this.compileExpr(e.lo, scope, opts);
        const H = this.compileExpr(e.hi, scope, opts);
        const base = (r, g, o, or) => {
          const v = C.fn(r, g, o, or);
          const lo = L.fn(r, g, o, or);
          const hi = H.fn(r, g, o, or);
          const a = cmpOp('>=', v, lo);
          const b = cmpOp('<=', v, hi);
          if (a === false || b === false) return false;
          if (a == null || b == null) return null;
          return true;
        };
        return { fn: e.not ? (r, g, o, or) => not3(base(r, g, o, or)) : base, refs: uni(C, L, H), hasAgg: C.hasAgg || L.hasAgg || H.hasAgg, wild: C.wild || L.wild || H.wild };
      }
      case 'like': {
        const C = this.compileExpr(e.e, scope, opts);
        const P = this.compileExpr(e.pat, scope, opts);
        const base = (r, g, o, or) => {
          const v = C.fn(r, g, o, or);
          const p = P.fn(r, g, o, or);
          if (v == null || p == null || typeof p !== 'string') return null;
          return likeToRe(p).test(String(v));
        };
        return { fn: e.not ? (r, g, o, or) => not3(base(r, g, o, or)) : base, refs: uni(C, P), hasAgg: C.hasAgg || P.hasAgg, wild: C.wild || P.wild };
      }
      case 'match': {
        const C = this.compileExpr(e.e, scope, opts);
        const P = this.compileExpr(e.pat, scope, opts);
        const base = (r, g, o, or) => {
          const v = C.fn(r, g, o, or);
          const p = P.fn(r, g, o, or);
          if (v == null || p == null || typeof p !== 'string') return null;
          const terms = p.toLowerCase().split(/\s+/).filter(Boolean);
          if (!terms.length) return null;   // 空查询不命中
          const text = String(v).toLowerCase();
          for (const term of terms) {
            if (!text.includes(term)) return false;
          }
          return true;
        };
        return { fn: e.not ? (r, g, o, or) => not3(base(r, g, o, or)) : base, refs: uni(C, P), hasAgg: C.hasAgg || P.hasAgg, wild: C.wild || P.wild };
      }
      case 'case': {
        /* 简单式:operand 逐个与 WHEN 值按 '=' 比较(null 不等);
         * 搜索式:WHEN 条件须 === true;无 ELSE 得 null */
        const opC = e.operand != null ? this.compileExpr(e.operand, scope, opts) : null;
        const ws = e.whens.map(({ w, r }) => ({ w: this.compileExpr(w, scope, opts), r: this.compileExpr(r, scope, opts) }));
        const els = e.els != null ? this.compileExpr(e.els, scope, opts) : null;
        const fn = (r, g, o, or) => {
          if (opC) {
            const v = opC.fn(r, g, o, or);
            for (const p of ws) {
              if (cmpOp('=', v, p.w.fn(r, g, o, or)) === true) return p.r.fn(r, g, o, or);
            }
          } else {
            for (const p of ws) {
              if (p.w.fn(r, g, o, or) === true) return p.r.fn(r, g, o, or);
            }
          }
          return els ? els.fn(r, g, o, or) : null;
        };
        const all = [...(opC ? [opC] : []), ...ws.flatMap((p) => [p.w, p.r]), ...(els ? [els] : [])];
        return {
          fn,
          refs: uni(...all),
          hasAgg: all.some((c) => c.hasAgg),
          wild: all.some((c) => c.wild),
        };
      }
      case 'in': return this.compileIn(e, scope, opts);
      case 'func': return this.compileFunc(e, scope, opts);
      case 'sub': return this.compileSubScalar(e, scope);
      case 'exists': return this.compileExists(e, scope);
      default: throw new Error(`SQL 内部错误:未知表达式节点 ${e.t}`);
    }
  }

  compileCol(e, scope, opts) {
    const parts = e.parts;
    if (scope.sources.includes(parts[0])) {
      const owner = parts[0];
      const at = scope.idx.get(owner);
      const path = parts.slice(1);
      return {
        fn: (row) => {
          const d = row?.[at];
          if (d == null) return null;
          return norm(pathGet(d, path));
        },
        refs: new Set([owner]),
        hasAgg: false,
        wild: false,
      };
    }
    if (scope.outer) {
      /* 外层引用(相关):在 outer scope 编译,求值于 outerRow */
      const R = this.compileExpr(e, scope.outer);
      return {
        fn: (row, group, out, outerRow) => R.fn(outerRow, null, null, null),
        refs: new Set(['outer']),
        hasAgg: false,
        wild: false,
      };
    }
    if (opts.strict) {
      throw new Error(`列 '${parts.join('.')}' 无法解析:相关子查询的关联列必须带直接外层表的别名前缀`);
    }
    /* 裸列:本层各源动态查找(取第一个含该字段的源)—— 按 scope 自身
     * 的序遍历(探测序 scope 配 [d] 探测行,首源即新表) */
    const key = parts[0];
    const path = parts;
    const n = scope.sources.length;
    return {
      fn: (row) => {
        if (row) {
          for (let i = 0; i < n; i++) {
            const d = row[i];
            if (d != null && key in d) return norm(pathGet(d, path));
          }
        }
        return null;
      },
      refs: new Set(scope.sources),
      hasAgg: false,
      wild: true,
    };
  }

  compileBin(e, scope, opts) {
    const L = this.compileExpr(e.l, scope, opts);
    const R = this.compileExpr(e.r, scope, opts);
    const op = e.op;
    let fn;
    if (op === 'AND') {
      fn = (r, g, o, or) => {
        const a = L.fn(r, g, o, or);
        if (a === false) return false;
        const b = R.fn(r, g, o, or);
        if (b === false) return false;
        if (a == null || b == null) return null;
        return true;
      };
    } else if (op === 'OR') {
      fn = (r, g, o, or) => {
        const a = L.fn(r, g, o, or);
        if (a === true) return true;
        const b = R.fn(r, g, o, or);
        if (b === true) return true;
        if (a == null || b == null) return null;
        return false;
      };
    } else if (op === '||') {
      fn = (r, g, o, or) => {
        const a = L.fn(r, g, o, or);
        const b = R.fn(r, g, o, or);
        if (a == null || b == null) return null;
        return String(a) + String(b);
      };
    } else if (op === '=') {
      fn = (r, g, o, or) => cmpOp('=', L.fn(r, g, o, or), R.fn(r, g, o, or));
    } else if (op === '!=') {
      fn = (r, g, o, or) => cmpOp('!=', L.fn(r, g, o, or), R.fn(r, g, o, or));
    } else if (['<', '<=', '>', '>='].includes(op)) {
      fn = (r, g, o, or) => cmpOp(op, L.fn(r, g, o, or), R.fn(r, g, o, or));
    } else {
      /* 算术:仅 number,含 null → null */
      fn = (r, g, o, or) => {
        const a = L.fn(r, g, o, or);
        const b = R.fn(r, g, o, or);
        if (typeof a !== 'number' || typeof b !== 'number') return null;
        if (op === '+') return a + b;
        if (op === '-') return a - b;
        if (op === '*') return a * b;
        if (op === '/') return b === 0 ? null : a / b;
        return b === 0 ? null : a % b;
      };
    }
    return { fn, refs: uni(L, R), hasAgg: L.hasAgg || R.hasAgg, wild: L.wild || R.wild };
  }

  compileIn(e, scope, opts) {
    const E = this.compileExpr(e.e, scope, opts);
    if (e.sub) {
      const corr = this.analyzeCorrelation(e.sub, scope);
      if (!corr) {
        /* 非相关:执行一次,缓存首列值集合 */
        const fn = (r, g, o, or) => {
          const { set, hasNull } = this.cached(e, () => {
            const rows = this.exec(e.sub);
            const s = new Set();
            let hn = false;
            for (const row of rows) {
              const v = Object.values(row)[0];
              if (v == null) hn = true;
              else s.add(normKey(v));
            }
            return { set: s, hasNull: hn };
          });
          const v = E.fn(r, g, o, or);
          if (v == null) return null;
          const has = set.has(normKey(v));
          const base = has ? true : hasNull ? null : false;
          return e.not ? not3(base) : base;
        };
        return { fn, refs: E.refs, hasAgg: E.hasAgg, wild: E.wild };
      }
      if (e.not) throw new Error('不支持:相关子查询的 NOT IN(NULL 语义陷阱,请改用 NOT EXISTS)');
      const aux = this.buildCorrAux(e.sub, corr, scope, 'in');
      const fn = (r, g, o, or) => {
        const kk = aux.keyOf(r);
        if (kk == null) return null;
        const set = aux.map.get(kk);
        const v = E.fn(r, g, o, or);
        if (v == null) return null;
        return set ? set.has(normKey(v)) : false;
      };
      return { fn, refs: new Set(['outer']), hasAgg: false, wild: false };
    }
    /* 字面列表 */
    const listC = e.list.map((x) => this.compileExpr(x, scope, opts));
    const fn = (r, g, o, or) => {
      const v = E.fn(r, g, o, or);
      if (v == null) return null;
      let hasNull = false;
      for (const C of listC) {
        const x = C.fn(r, g, o, or);
        if (x == null) { hasNull = true; continue; }
        if (cmpVal(v, x) === 0) return e.not ? false : true;
      }
      const base = hasNull ? null : false;
      return e.not ? not3(base) : base;
    };
    const refs = uni(E, ...listC);
    return { fn, refs, hasAgg: listC.some((c) => c.hasAgg) || E.hasAgg, wild: E.wild };
  }

  compileFunc(e, scope, opts) {
    const name = e.name;
    if (AGG_FUNCS.has(name)) {
      if (!e.star && e.args.length !== 1) throw new Error(`${name} 需要恰好一个参数`);
      if (e.distinct && e.star) throw new Error(`${name}(DISTINCT *) 不支持`);
      if (!e.star) {
        const probe = this.compileExpr(e.args[0], scope, opts);
        if (probe.hasAgg) throw new Error('聚合函数不能嵌套');
      }
      const node = e;
      const fn = (row, group) => {
        if (!group) throw new Error(`${name} 只能用于 GROUP BY 查询或整体聚合`);
        if (group.aggs.has(node)) return group.aggs.get(node);
        const v = this.computeAgg(node, group, scope);
        group.aggs.set(node, v);
        return v;
      };
      return { fn, refs: new Set(), hasAgg: true, wild: false };
    }
    const args = e.args.map((a) => this.compileExpr(a, scope, opts));
    const F = (r, g, o, or) => args.map((C) => C.fn(r, g, o, or));
    let fn;
    if (name === 'COALESCE') {
      fn = (r, g, o, or) => { for (const C of args) { const v = C.fn(r, g, o, or); if (v != null) return v; } return null; };
    } else if (name === 'LOWER') {
      fn = (r, g, o, or) => { const [v] = F(r, g, o, or); return v == null ? null : String(v).toLowerCase(); };
    } else if (name === 'UPPER') {
      fn = (r, g, o, or) => { const [v] = F(r, g, o, or); return v == null ? null : String(v).toUpperCase(); };
    } else if (name === 'LENGTH') {
      fn = (r, g, o, or) => {
        const [v] = F(r, g, o, or);
        if (v == null) return null;
        return Array.isArray(v) ? v.length : String(v).length;
      };
    } else if (name === 'ABS') {
      fn = (r, g, o, or) => { const [v] = F(r, g, o, or); return typeof v === 'number' ? Math.abs(v) : null; };
    } else if (name === 'ROUND') {
      fn = (r, g, o, or) => {
        const [v, d] = F(r, g, o, or);
        if (typeof v !== 'number') return null;
        const p = typeof d === 'number' ? d : 0;
        const m = 10 ** p;
        return Math.round(v * m) / m;
      };
    } else if (name === 'INSTR') {
      /* 首次出现位置(1 起),未命中 0,任一为 null 得 null —— SQLite 同款 */
      fn = (r, g, o, or) => {
        const [v, p] = F(r, g, o, or);
        if (v == null || p == null) return null;
        const idx = String(v).indexOf(String(p));
        return idx < 0 ? 0 : idx + 1;
      };
    } else {
      throw new Error(`未知函数: ${name}(可用:COUNT SUM AVG MIN MAX LOWER UPPER LENGTH ABS ROUND COALESCE INSTR)`);
    }
    return { fn, refs: uni(...args), hasAgg: args.some((c) => c.hasAgg), wild: args.some((c) => c.wild) };
  }

  computeAgg(node, group, scope) {
    const { name, star, distinct } = node;
    if (star) return group.rows.length;  // 仅 COUNT(*) 允许 star(编译时已限)
    if (!this._argC) this._argC = new Map();
    if (!this._argC.has(node)) this._argC.set(node, this.compileExpr(node.args[0], scope));
    const argC = this._argC.get(node);
    let vals = [];
    for (const r of group.rows) {
      const v = argC.fn(r, null, null, null);
      if (v != null) vals.push(v);
    }
    if (distinct) {
      const seen = new Set();
      const u = [];
      for (const v of vals) {
        const k = normKey(v);
        if (!seen.has(k)) { seen.add(k); u.push(v); }
      }
      vals = u;
    }
    if (name === 'COUNT') return vals.length;
    if (name === 'SUM' || name === 'AVG') {
      let s = 0;
      let n = 0;
      for (const v of vals) {
        if (typeof v === 'number') { s += v; n++; }
      }
      if (!n) return null;
      return name === 'SUM' ? s : s / n;
    }
    /* MIN / MAX */
    if (!vals.length) return null;
    return vals.reduce((a, b) => ((name === 'MIN' ? cmpVal(b, a) < 0 : cmpVal(b, a) > 0) ? b : a));
  }

  /* ---------- 子查询 ---------- */

  /**
   * 相关性分析:返回 null(非相关)或 { eqPairs, residual }。
   * 等值相关:WHERE 的顶层 AND 项中,一侧纯内层、一侧纯外层(带前缀)的等式;
   * 其余含外层引用的项一律报不支持。
   */
  analyzeCorrelation(q, outerScope) {
    if (!outerScope || !outerScope.sources.length) return null;
    const innerAliases = new Set([q.from.alias, ...q.joins.map((j) => j.ref.alias)]);
    const collect = (e, acc) => {
      if (e == null) return acc;
      switch (e.t) {
        case 'col':
          if (innerAliases.has(e.parts[0])) acc.inner = true;
          else if (outerScope.sources.includes(e.parts[0])) acc.outer = true;
          else acc.wild = true;
          break;
        case 'bin': collect(e.l, acc); collect(e.r, acc); break;
        case 'not': case 'neg': collect(e.e, acc); break;
        case 'isnull': collect(e.e, acc); break;
        case 'in':
          collect(e.e, acc);
          for (const x of e.list ?? []) collect(x, acc);
          break;
        case 'between': collect(e.e, acc); collect(e.lo, acc); collect(e.hi, acc); break;
        case 'like': collect(e.e, acc); collect(e.pat, acc); break;
        case 'match': collect(e.e, acc); collect(e.pat, acc); break;
        case 'case':
          if (e.operand != null) collect(e.operand, acc);
          for (const w of e.whens) { collect(w.w, acc); collect(w.r, acc); }
          if (e.els != null) collect(e.els, acc);
          break;
        case 'func': for (const a of e.args) collect(a, acc); break;
        default: break;  // sub/exists 嵌套按黑盒处理(其内部作用域独立)
      }
      return acc;
    };
    const eqPairs = [];
    const residual = [];
    for (const c of flattenAnd(q.where)) {
      const acc = collect(c, { inner: false, outer: false, wild: false });
      if (!acc.outer) { residual.push(c); continue; }
      if (c?.t === 'bin' && c.op === '=' && !acc.wild) {
        const la = collect(c.l, { inner: false, outer: false, wild: false });
        const ra = collect(c.r, { inner: false, outer: false, wild: false });
        if (la.outer && !la.inner && ra.inner && !ra.outer) {
          eqPairs.push({ outerE: c.l, innerE: c.r });
          continue;
        }
        if (ra.outer && !ra.inner && la.inner && !la.outer) {
          eqPairs.push({ outerE: c.r, innerE: c.l });
          continue;
        }
      }
      throw new Error('不支持:相关子查询仅支持等值关联(关联列须带表别名前缀)');
    }
    /* WHERE 之外的位置(投影/HAVING/GROUP/ORDER)出现外层引用 → 不支持,
     * 防止静默解析失败产出错误数据 */
    const scanOther = (e) => {
      if (collect(e, { inner: false, outer: false, wild: false }).outer) {
        throw new Error('不支持:子查询仅 WHERE 支持外层引用(等值关联)');
      }
    };
    for (const it of q.items) if (it.e) scanOther(it.e);
    if (q.having) scanOther(q.having);
    for (const g of q.groupBy) scanOther(g);
    for (const o of q.orderBy) scanOther(o.e);
    return eqPairs.length ? { eqPairs, residual } : null;
  }

  requireSingleColumn(q) {
    if (q.items.length !== 1 || q.items[0].star) {
      throw new Error('该位置的子查询必须恰好输出一列');
    }
    return this.compileExpr(q.items[0].e, mkScope([q.from.alias]));
  }

  /**
   * 相关子查询 hash 化:内层过滤后按关联键建 Set/Map,外层 O(1) 探测。
   * kind: 'exists' | 'in' | 'scalar'
   */
  buildCorrAux(q, corr, outerScope, kind) {
    if (q.joins.length) throw new Error('不支持:相关子查询内含 JOIN');
    const alias = q.from.alias;
    const subScope = mkScope([alias]);
    const resFn = corr.residual.length
      ? this.compileExpr(corr.residual.reduce((a, b) => ({ t: 'bin', op: 'AND', l: a, r: b })), subScope).fn
      : null;
    const innerKeyFns = corr.eqPairs.map((p) => this.compileExpr(p.innerE, subScope).fn);
    /* 外层键:strict 编译(必须带直接外层前缀) */
    const outerKeyFns = corr.eqPairs.map((p) => this.compileExpr(p.outerE, outerScope, { strict: true }).fn);

    const innerRows = this.sourceRows(q.from);
    /* 单键:原值直接作键(与 exec 的 join 桶同一套 KeyMap 原语) */
    const single = corr.eqPairs.length === 1;
    const map = new KeyMap();
    for (const d of innerRows) {
      const row = [d];
      if (resFn && resFn(row, null, null, null) !== true) continue;
      const kk = single
        ? innerKeyFns[0](row, null, null, null)
        : keyTuple(innerKeyFns.map((f) => f(row, null, null, null)));
      if (kk == null) continue;
      let g = map.get(kk);
      if (!g) map.set(kk, (g = { rows: [], docs: [] }));
      g.rows.push(row);
      g.docs.push(d);
    }
    const keyOf = (r) => (single
      ? outerKeyFns[0](r, null, null, null)
      : keyTuple(outerKeyFns.map((f) => f(r, null, null, null))));

    if (kind === 'exists') {
      return { map, keyOf, hit: (kk) => kk != null && map.has(kk) };
    }
    if (kind === 'in') {
      const valC = this.requireSingleColumn(q);
      for (const g of map.values()) {
        g.vals = new Set(g.rows.map((r) => normKey(valC.fn(r, null, null, null))).filter((k) => k !== '\u0000'));
      }
      return { map, keyOf };
    }
    /* scalar:单列聚合,逐组预计算 */
    if (q.groupBy.length) throw new Error('不支持:相关标量子查询含 GROUP BY');
    const item = q.items[0];
    if (q.items.length !== 1 || item.star || item.e.t !== 'func' || !AGG_FUNCS.has(item.e.name)) {
      throw new Error('相关标量子查询必须为单聚合输出,如 (SELECT COUNT(*) FROM … WHERE t.k = outer.k)');
    }
    const aggNode = item.e;
    const aggScope = subScope;
    for (const g of map.values()) {
      g.aggs = new Map();
      g.aggValue = this.computeAgg(aggNode, { rows: g.rows, aggs: g.aggs }, aggScope);
    }
    const emptyDefault = aggNode.name === 'COUNT' ? 0 : null;
    return { map, emptyDefault, keyOf };
  }

  compileSubScalar(e, scope) {
    const corr = this.analyzeCorrelation(e.q, scope);
    if (!corr) {
      const fn = () => {
        const rows = this.cached(e, () => this.exec(e.q));
        return rows.length ? norm(Object.values(rows[0])[0]) : null;
      };
      return { fn, refs: new Set(), hasAgg: false, wild: false };
    }
    const aux = this.buildCorrAux(e.q, corr, scope, 'scalar');
    const fn = (r) => {
      const kk = aux.keyOf(r);
      if (kk == null) return null;
      const g = aux.map.get(kk);
      return g ? norm(g.aggValue) : aux.emptyDefault;
    };
    return { fn, refs: new Set(['outer']), hasAgg: false, wild: false };
  }

  compileExists(e, scope) {
    const corr = this.analyzeCorrelation(e.q, scope);
    if (!corr) {
      const fn = () => this.cached(e, () => this.exec(e.q).length > 0);
      return { fn, refs: new Set(), hasAgg: false, wild: false };
    }
    const aux = this.buildCorrAux(e.q, corr, scope, 'exists');
    const fn = (r) => {
      const kk = aux.keyOf(r);
      return kk != null && aux.hit(kk);
    };
    return { fn, refs: new Set(['outer']), hasAgg: false, wild: false };
  }

  /* ---------- JOIN ---------- */

  /** ON 等值编译:返回 [{left, right}](外层行键 / 新表键);多 AND 项为多键。
   *  左键按积累行序编译(求值于 join 前的积累行);右键按"新表优先"探测序
   *  编译(求值于 [文档] 单元探测行,右键表达式只引用新表) */
  compileJoinOn(on, accumSources, newAlias) {
    const pairs = [];
    const rowScope = mkScope([...accumSources, newAlias]);
    const probeScope = mkScope([newAlias, ...accumSources]);
    for (const c of flattenAnd(on)) {
      if (c?.t !== 'bin' || c.op !== '=') {
        throw new Error('JOIN ON 仅支持等值条件(可 AND 多键);范围连接不支持');
      }
      const L = this.compileExpr(c.l, rowScope);
      const R = this.compileExpr(c.r, rowScope);
      const subsetNew = (s) => s.size > 0 && [...s].every((x) => x === newAlias);
      const disjointNew = (s) => !s.has(newAlias);
      const rightOf = (e) => this.compileExpr(e, probeScope).fn;
      if (subsetNew(L.refs) && !L.wild && disjointNew(R.refs) && !R.wild && R.refs.size > 0) {
        pairs.push({ left: R.fn, right: rightOf(c.l) });
      } else if (subsetNew(R.refs) && !R.wild && disjointNew(L.refs) && !L.wild && L.refs.size > 0) {
        pairs.push({ left: L.fn, right: rightOf(c.r) });
      } else if (L.wild && disjointNew(R.refs) && !R.wild && R.refs.size > 0) {
        /* 裸列侧按新表优先解析 */
        pairs.push({ left: R.fn, right: rightOf(c.l) });
      } else if (R.wild && disjointNew(L.refs) && !L.wild && L.refs.size > 0) {
        pairs.push({ left: L.fn, right: rightOf(c.r) });
      } else {
        throw new Error(`JOIN ON 条件无法定向(裸列请加表别名前缀)`);
      }
    }
    return pairs;
  }

  /* ---------- 主执行(同步;数据均已物化) ---------- */

  exec(q) {
    const accSources = [q.from.alias];   /* 积累行序 = 文档数组下标 */

    /* WHERE 谓词下推:AND 合取项按引用源提前过滤,缩小进入 join 的行集。
     * 全源 scope 预编译(与整条编译的解析/报错语义一致)。单源项推到该表
     * 进入处 —— FROM 侧与 INNER 新表侧均与 join 后过滤等价,LEFT 新表侧
     * 可空(null 扩展行会凭空存活)不推;多源项在引用源齐备的下一层 join
     * 前过滤(每条输出行唯一继承一条积累行,等价)。含聚合(维持原报错
     * 时机)或相关子查询(refs 含 'outer',行依赖不可移位)的项留在原位。
     * AND 仅两侧均真才为真,拆项逐个 === true 过滤与整条过滤结果一致。 */
    /* 全源 scope:WHERE 合取项与投影/HAVING/GROUP/ORDER 引用的源集合在
     * 解析期即完全确定,统一在 join 前编译(与 join 后编译等价,报错语义
     * 一致)——LIMIT 短路需要先知道排序/聚合/去重的存在 */
    const fullScope = mkScope([q.from.alias, ...q.joins.map((j) => j.ref.alias)]);
    const lateFns = [];
    let pending = [];
    if (q.where) {
      for (const c of flattenAnd(q.where)) {
        const cc = this.compileExpr(c, fullScope);
        if (cc.hasAgg || cc.refs.has('outer')) lateFns.push(cc.fn);
        else pending.push(cc);
      }
    }
    const grab = (ok) => {
      const fns = [];
      const keep = [];
      for (const c of pending) { if (ok(c)) fns.push(c.fn); else keep.push(c); }
      pending = keep;
      return fns;
    };
    /* 过滤对象是数组行;源侧文档按下标临时包装后再喂谓词 */
    const keepRows = (rs, fns) => (fns.length
      ? rs.filter((r) => fns.every((f) => f(r, null, null, null) === true))
      : rs);
    const keepDocs = (ds, at, fns) => (fns.length
      ? ds.filter((d) => { const w = []; w[at] = d; return fns.every((f) => f(w, null, null, null) === true); })
      : ds);

    /* 投影项先编译(HAVING/GROUP BY/ORDER BY 可引用投影别名) */
    const items = q.items.map((it) => (it.star ? it : { ...it, c: this.compileExpr(it.e, fullScope) }));
    const rewrite = (e) => rewriteAliasRefs(e, items);
    const havingC = q.having ? this.compileExpr(rewrite(q.having), fullScope) : null;
    const groupCs = q.groupBy.map((g) => this.compileExpr(rewrite(g), fullScope));
    const orderCs = q.orderBy.map(({ e, desc }) => ({ c: this.compileExpr(rewrite(e), fullScope), desc }));

    const aggMode = groupCs.length > 0
      || items.some((it) => !it.star && it.c.hasAgg)
      || (havingC ? havingC.hasAgg : false)
      || orderCs.some((o) => o.c.hasAgg);

    /* LIMIT 短路:无 DISTINCT/排序/聚合时产出顺序即结果顺序,产出为稳定
     * 前缀,只产前 offset+limit 行与全量产出后切片逐行一致;剩余 WHERE
     * 谓词随之内联到产出点应用 */
    const off = q.offset ?? 0;
    const need = q.limit != null ? off + q.limit : null;
    const shortLimit = need != null && !q.distinct && !orderCs.length && !aggMode ? need : null;
    let whereInlined = false;

    /* FROM 表:仅引用 FROM 别名的项在包装前过滤文档;单表 + 短路边产边停 */
    const fromFns = grab((c) => c.refs.size === 1 && c.refs.has(q.from.alias));
    let rows;
    if (!q.joins.length && shortLimit != null) {
      const post = [...lateFns, ...pending.map((c) => c.fn)];
      whereInlined = true;
      rows = [];
      for (const d of this.sourceRows(q.from)) {
        if (rows.length >= shortLimit) break;
        const w = [d];
        if (!fromFns.every((f) => f(w, null, null, null) === true)) continue;
        if (!post.every((f) => f(w, null, null, null) === true)) continue;
        rows.push(w);
      }
    } else {
      rows = keepDocs(this.sourceRows(q.from), 0, fromFns).map((d) => [d]);
    }

    for (let ji = 0; ji < q.joins.length; ji++) {
      const j = q.joins[ji];
      /* 引用源已齐备的项(多源项在此下推):每条输出行唯一继承一条积累行 */
      rows = keepRows(rows, grab((c) => [...c.refs].every((a) => accSources.includes(a))));

      let jrows = this.sourceRows(j.ref);
      const newPos = accSources.length;   /* 新表在行数组中的下标 */
      const pairs = this.compileJoinOn(j.on, accSources, j.ref.alias);
      accSources.push(j.ref.alias);
      if (j.type === 'inner') {
        /* INNER:桶内的行即最终行,建桶前过滤 */
        jrows = keepDocs(jrows, newPos, grab((c) => c.refs.size === 1 && c.refs.has(j.ref.alias)));
      }
      /* 单键等值:原值直接作 Map 键免拼串;多键退 JSON 元组串 */
      const single = pairs.length === 1;
      const buckets = single ? new KeyMap() : new Map();
      for (const d of jrows) {
        const probe = [d];   /* 右键按探测序编译,新表即下标 0 */
        const kk = single
          ? pairs[0].right(probe, null, null, null)
          : keyTuple(pairs.map((p) => p.right(probe, null, null, null)));
        if (kk == null) continue;  // null 键不匹配
        let arr = buckets.get(kk);
        if (!arr) buckets.set(kk, (arr = []));
        arr.push(d);
      }
      /* 末层 join + 短路:剩余谓词内联应用,产够 offset+limit 行即停 */
      const inline = ji === q.joins.length - 1 && shortLimit != null
        ? [...lateFns, ...pending.map((c) => c.fn)]
        : null;
      if (inline) whereInlined = true;
      const next = [];
      prod: for (const lr of rows) {
        if (inline && next.length >= shortLimit) break prod;
        const kk = single
          ? pairs[0].left(lr, null, null, null)
          : keyTuple(pairs.map((p) => p.left(lr, null, null, null)));
        const hits = kk == null ? null : buckets.get(kk);
        if (hits) {
          for (const d of hits) {
            if (inline && next.length >= shortLimit) break prod;
            const nr = lr.concat(d);
            if (inline && !inline.every((f) => f(nr, null, null, null) === true)) continue;
            next.push(nr);
          }
        } else if (j.type === 'left') {
          const nr = lr.concat(NULLROW);
          if (inline && !inline.every((f) => f(nr, null, null, null) === true)) continue;
          next.push(nr);
        }
      }
      rows = next;
    }

    if (q.where && !whereInlined) {
      /* 剩余项(聚合 / 相关子查询 / LEFT 右侧引用 / 引用源未齐备)按原位置过滤 */
      rows = keepRows(rows, [...lateFns, ...pending.map((c) => c.fn)]);
    }

    /* 投影(浅拷贝顶层,嵌套值与物化共享 —— 结果约定只读)。
     * 聚合取每组首行求值;排序键直接挂在投影对象上,免 keyed 包装 */
    const project = (row, group) => {
      const out = {};
      for (const it of items) {
        if (it.star === true) {
          for (let i = 0; i < fullScope.sources.length; i++) Object.assign(out, row?.[i] ?? {});
        } else if (typeof it.star === 'string') {
          Object.assign(out, row?.[fullScope.idx.get(it.star)] ?? {});
        } else {
          out[it.name] = norm(it.c.fn(row, group, out, null));
        }
      }
      return { out, row, group };
    };
    /* 排序比较:null 恒排最后,不随 DESC 翻转;文本键按 collation(默认拼音) */
    const oc = collOf(this.collation);
    const cmpKeyed = (a, b) => {
      for (let idx = 0; idx < orderCs.length; idx++) {
        const va = a.ks[idx];
        const vb = b.ks[idx];
        if (va == null || vb == null) {
          if (va != null) return -1;
          if (vb != null) return 1;
          continue;
        }
        const c = oc && typeof va === 'string' && typeof vb === 'string' ? oc.compare(va, vb) : cmpVal(va, vb);
        if (c) return orderCs[idx].desc ? -c : c;
      }
      return 0;
    };

    if (orderCs.length && need != null && !q.distinct && !aggMode && need < rows.length) {
      /* top-N:流式投影 + 定长 need 的"最差居顶"堆 —— 免全量排序,投影
       * 对象仅保留 need 个(淘汰者即刻可回收);与全量排序后切片逐行一致 */
      if (!need) return [];
      const heap = [];
      const siftUp = (i) => {
        const e = heap[i];
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (cmpKeyed(heap[p], e) >= 0) break;
          heap[i] = heap[p];
          i = p;
        }
        heap[i] = e;
      };
      const siftDown = () => {
        const n = heap.length;
        const e = heap[0];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && cmpKeyed(heap[c + 1], heap[c]) > 0) c++;
          if (cmpKeyed(heap[c], e) <= 0) break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = e;
      };
      for (const r of rows) {
        const x = project(r, null);
        x.ks = orderCs.map((o) => o.c.fn(r, null, null, null));
        if (heap.length < need) { heap.push(x); siftUp(heap.length - 1); }
        else if (cmpKeyed(x, heap[0]) < 0) { heap[0] = x; siftDown(); }
      }
      heap.sort(cmpKeyed);
      return heap.slice(off).map((x) => x.out);
    }

    let outs;
    if (aggMode) {
      const groups = new Map();
      if (groupCs.length) {
        for (const r of rows) {
          const kk = groupKey(groupCs.map((c) => c.fn(r, null, null, null)));
          let g = groups.get(kk);
          if (!g) groups.set(kk, (g = { rows: [], aggs: new Map() }));
          g.rows.push(r);
        }
      } else {
        groups.set('\u0000all', { rows, aggs: new Map() });  // 空表也产一行(COUNT(*)=0)
      }
      let gs = [...groups.values()];
      if (havingC) gs = gs.filter((g) => havingC.fn(g.rows[0] ?? null, g, null, null) === true);
      outs = gs.map((g) => project(g.rows[0] ?? null, g));
    } else {
      outs = rows.map((r) => project(r, null));
    }

    if (q.distinct) {
      const seen = new Set();
      outs = outs.filter(({ out }) => {
        const kk = JSON.stringify(Object.entries(out).map(([k, v]) => [k, normKey(v)]));
        if (seen.has(kk)) return false;
        seen.add(kk);
        return true;
      });
    }

    if (orderCs.length) {
      for (const e of outs) e.ks = orderCs.map((o) => o.c.fn(e.row, e.group, null, null));
      outs.sort(cmpKeyed);
    }

    if (off || q.limit != null) {
      outs = outs.slice(off, q.limit != null ? off + q.limit : undefined);
    }
    return outs.map((e) => e.out);
  }
}

/** 裸列引用递归替换为投影别名的源表达式(不深入子查询 —— 其作用域独立) */
function rewriteAliasRefs(e, items) {
  if (e == null || typeof e !== 'object') return e;
  switch (e.t) {
    case 'col': {
      if (e.parts.length === 1) {
        const hit = items.find((it) => !it.star && it.alias === e.parts[0]);
        if (hit) return hit.e;
      }
      return e;
    }
    case 'bin': return { ...e, l: rewriteAliasRefs(e.l, items), r: rewriteAliasRefs(e.r, items) };
    case 'not':
    case 'neg': return { ...e, e: rewriteAliasRefs(e.e, items) };
    case 'isnull': return { ...e, e: rewriteAliasRefs(e.e, items) };
    case 'in': return { ...e, e: rewriteAliasRefs(e.e, items), list: (e.list ?? []).map((x) => rewriteAliasRefs(x, items)) };
    case 'between': return { ...e, e: rewriteAliasRefs(e.e, items), lo: rewriteAliasRefs(e.lo, items), hi: rewriteAliasRefs(e.hi, items) };
    case 'like': return { ...e, e: rewriteAliasRefs(e.e, items), pat: rewriteAliasRefs(e.pat, items) };
    case 'match': return { ...e, e: rewriteAliasRefs(e.e, items), pat: rewriteAliasRefs(e.pat, items) };
    case 'case': return {
      ...e,
      operand: rewriteAliasRefs(e.operand, items),
      whens: e.whens.map((w) => ({ w: rewriteAliasRefs(w.w, items), r: rewriteAliasRefs(w.r, items) })),
      els: rewriteAliasRefs(e.els, items),
    };
    case 'func': return { ...e, args: e.args.map((a) => rewriteAliasRefs(a, items)) };
    default: return e;  // lit / param / sub / exists
  }
}

function uni(...cs) {
  const s = new Set();
  for (const c of cs) for (const r of c.refs) s.add(r);
  return s;
}

/* ---------- 入口 ---------- */

/**
 * 执行只读 SQL。解析同步;物化经各集合 loadAll()(逐个排队,与写串行,
 * 得到一致性快照);随后 exec 为纯内存同步操作(数组是稳定快照,Collection
 * 写路径只失效缓存、不修改已物化数组),无需持有队列。
 * @param {import('./database.js').Database} db
 * @param {string} text
 * @param {Array} params
 */
export async function runSql(db, text, params, opts) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('SQL 不能为空');
  if (params != null && !Array.isArray(params)) throw new Error('SQL 参数必须是数组');
  const ast = parse(text);
  const ps = params ?? [];
  if (ast.__paramCount > ps.length) {
    throw new Error(`SQL 需要 ${ast.__paramCount} 个参数,只提供 ${ps.length} 个`);
  }
  const rt = new Runtime(db, ps, opts);
  await rt.resolve(ast);
  return rt.exec(ast);
}

export default { parse, runSql };
