/* ============================================================
 * Schema —— 集合级字段声明 / 校验 / 自动演化
 *
 * 模型:
 *   · schema 挂在集合元数据上(cat.cols[name].schema),随目录
 *     双超级块原子落盘 —— 写入时吸收的字段与文档同事务提交;
 *   · 两类模式:
 *       strict —— 写入按声明校验,未知字段按 extra 策略处理;
 *       auto   —— 写入遇到未知字段自动吸收(推断类型),类型
 *                 变化自动放宽为 union,与文档同事务落盘。
 *   · 字段声明支持简写:'string' / ['string','null'] /
 *     { type, required?, default?, items? }。
 *
 * 类型:'string' | 'number' | 'boolean' | 'object' | 'array'
 * (**类型声明不含 null** —— 非必填字段一律可空,required 字段不得为 null;
 *  undefined 与 null 存储前统一按 null 对待)。
 * ============================================================ */

const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

/** 值 → 类型名 */
export function typeOf(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

/** 数组元素类型:全部同型标量 → 该类型,否则 null(无约束) */
function itemTypeOf(arr) {
  if (!arr.length) return null;
  const t = typeOf(arr[0]);
  if (!SCALAR_TYPES.has(t)) return null;
  for (let i = 1; i < arr.length; i++) {
    if (typeOf(arr[i]) !== t) return null;
  }
  return t;
}

/** 规范化单字段声明 */
function normalizeField(spec, fieldName) {
  let types;
  let required = false;
  let hasDefault = false;
  let def;
  let items = null;
  if (typeof spec === 'string') types = [spec];
  else if (Array.isArray(spec)) types = [...spec];
  else if (spec && typeof spec === 'object') {
    const t = spec.type;
    if (typeof t === 'string') types = [t];
    else if (Array.isArray(t)) types = [...t];
    else if (t == null) types = null;
    else throw new Error(`字段 ${fieldName} 的 type 声明无效`);
    required = !!spec.required;
    if ('default' in spec) {
      hasDefault = true;
      def = spec.default;
    }
    if (spec.items != null) {
      items = typeof spec.items === 'string' ? [spec.items] : [...spec.items];
    }
  } else if (spec == null) {
    types = null;
  } else {
    throw new Error(`字段 ${fieldName} 的声明无效`);
  }
  if (types) {
    for (const t of types) {
      if (typeof t !== 'string' || !SCALAR_TYPES.has(t) && t !== 'object' && t !== 'array' && t !== 'null') {
        throw new Error(`字段 ${fieldName} 含未知类型: ${t}`);
      }
    }
    /* null 不参与类型:非必填字段一律隐式可空,声明里的 'null' 剥除 */
    types = types.filter((x) => x !== 'null');
    if (!types.length) types = null;
  }
  const out = { types, required, hasDefault, default: def, items };
  if (required && hasDefault) throw new Error(`字段 ${fieldName} 不能同时 required 和 default`);
  return out;
}

/**
 * 规范化整个 schema 声明。
 * @param {object|string[]} fields 字段映射(或空)
 * @param {object} [opts] { mode?: 'strict'|'auto', extra?: 'reject'|'allow'|'strip' }
 */
export function normalizeSchema(fields, opts = {}) {
  const mode = opts.mode === 'auto' ? 'auto' : 'strict';
  const extra = ['reject', 'allow', 'strip'].includes(opts.extra) ? opts.extra : 'reject';
  const out = { v: 1, mode, extra, fields: {} };
  if (fields == null) return out;
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('schema 字段声明必须是对象');
  for (const [name, spec] of Object.entries(fields)) {
    if (name === 'id') continue;  // 主键由库管理(string),不参与校验
    out.fields[name] = normalizeField(spec, name);
  }
  return out;
}

/** 从值推断字段声明(auto 吸收用;吸收的字段一律可选 —— 旧文档可能没有;
 *  null 值起步的字段类型未知(types=null),首见实际值时学习) */
export function inferField(v) {
  const t = typeOf(v);
  const f = { types: t === 'null' ? null : [t], required: false, hasDefault: false, default: undefined, items: null };
  if (t === 'array') {
    const it = itemTypeOf(v);
    if (it) f.items = [it];
  }
  return f;
}

/** 补默认值(就地;返回是否补过 —— default 需深拷贝以防引用共享) */
export function applyDefaults(doc, schema) {
  let touched = false;
  for (const [name, f] of Object.entries(schema.fields)) {
    if (f.hasDefault && !(name in doc)) {
      doc[name] = structuredClone(f.default);
      touched = true;
    }
  }
  return touched;
}

/**
 * strict 校验:返回错误列表(空 = 通过)。
 * 未知字段按 schema.extra 处理:reject → 报错;allow/strip → 不报。
 */
export function checkDoc(doc, schema) {
  const errs = [];
  for (const [name, f] of Object.entries(schema.fields)) {
    if (!(name in doc)) {
      if (f.required && !f.hasDefault) errs.push(`缺少必填字段 ${name}`);
      continue;
    }
    const t = typeOf(doc[name]);
    if (t === 'null') {
      /* 可选字段一律可空(类型声明不含 null);required 字段不得为 null */
      if (f.required) errs.push(`必填字段 ${name} 不能为 null`);
      continue;
    }
    if (f.types && !f.types.includes(t)) {
      errs.push(`字段 ${name} 期望 ${f.types.join('|')},得到 ${t}`);
      continue;
    }
    if (f.items && t === 'array') {
      for (const el of doc[name]) {
        if (!f.items.includes(typeOf(el))) {
          errs.push(`字段 ${name} 的元素期望 ${f.items.join('|')},得到 ${typeOf(el)}`);
          break;
        }
      }
    }
  }
  if (schema.extra === 'reject') {
    for (const name of Object.keys(doc)) {
      if (name !== 'id' && !(name in schema.fields)) errs.push(`未知字段 ${name}`);
    }
  }
  return errs;
}

/** strict 的 strip 策略:删掉未声明字段(就地) */
export function stripUnknown(doc, schema) {
  for (const name of Object.keys(doc)) {
    if (name !== 'id' && !(name in schema.fields)) delete doc[name];
  }
}

/**
 * auto 吸收(就地演化 schema.fields;返回错误列表,空 = 通过)。
 *   · 未知字段 → 按值推断并入声明(可选字段);
 *   · null → 对可选字段合法,不引起任何演化(required 冲突由 checkRequired 把关);
 *   · 类型未知的字段(吸收时值为 null)首见实际值 → 学习类型(单向:无 → 有);
 *   · 其他类型不匹配 → 报错(不放宽为联合类型);
 *   · 数组元素类型冲突 → 报错(不放弃 items 约束)。
 * schema 对象挂在目录上,演化随写事务原子落盘;失败时 Txn 回滚快照,
 * 本次吸收一并撤销。
 */
export function absorbDoc(doc, schema) {
  const errs = [];
  const fields = schema.fields;
  for (const [name, value] of Object.entries(doc)) {
    if (name === 'id') continue;
    const t = typeOf(value);
    const f = fields[name];
    if (!f) {
      fields[name] = inferField(value);
      continue;
    }
    if (t === 'null') continue;
    if (!f.types) {
      f.types = [t];
      if (t === 'array') {
        const it = itemTypeOf(value);
        if (it) f.items = [it];
      }
      continue;
    }
    if (!f.types.includes(t)) {
      errs.push(`字段 ${name} 期望 ${f.types.join('|')},得到 ${t}(auto 不放宽类型)`);
      continue;
    }
    if (t === 'array' && f.items) {
      for (const el of value) {
        if (!f.items.includes(typeOf(el))) {
          errs.push(`字段 ${name} 的元素期望 ${f.items.join('|')},得到 ${typeOf(el)}(auto 不放弃元素约束)`);
          break;
        }
      }
    }
  }
  return errs;
}

/** required 检查(auto 吸收不影响必填约束;default 已由 applyDefaults 补齐;
 *  required 字段缺键或值为 null 均视为缺失) */
export function checkRequired(doc, schema) {
  const errs = [];
  for (const [name, f] of Object.entries(schema.fields)) {
    if (!f.required) continue;
    if (!(name in doc)) errs.push(`缺少必填字段 ${name}`);
    else if (doc[name] === null) errs.push(`必填字段 ${name} 不能为 null`);
  }
  return errs;
}
