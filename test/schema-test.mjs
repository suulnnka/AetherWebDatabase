/* AetherWebDatabase 测试:schema 声明 / 写入校验 / auto 吸收演化 / setSchema / migrateSchema / 物化失效。
 *
 * 运行:node test/schema-test.mjs
 */
import assert from 'node:assert';
import { open, createMemoryBackend, normalizeSchema, checkDoc } from '../src/index.js';

let pass = 0;
let fail = 0;
const sections = [];

const section = (name, fn) => sections.push({ name, fn });
const t = (name, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`);
  }
};
const deepEq = (got, want, msg) =>
  t(msg, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);

const newDb = async (name = 's') => open(name, { storage: createMemoryBackend() });

/* ---------- 纯函数 ---------- */
section('normalizeSchema / checkDoc 纯函数', () => {
  const sc = normalizeSchema({
    title: { type: 'string', required: true },
    views: { type: 'number', default: 0 },
    tags: { type: 'array', items: 'string' },
    note: 'string',
    id: { type: 'string' },
  });
  t('mode 默认 strict', sc.mode === 'strict');
  t('id 被排除出校验字段', !('id' in sc.fields));
  t('required 生效', sc.fields.title.required === true);
  t('default 记录', sc.fields.views.hasDefault === true && sc.fields.views.default === 0);
  t('数组 type 归一', JSON.stringify(sc.fields.note.types) === '["string"]');
  t("声明里的 'null' 被剥除(可选即隐式可空)", (() => {
    const s2 = normalizeSchema({ x: ['string', 'null'], y: ['null'] });
    return JSON.stringify(s2.fields.x.types) === '["string"]' && s2.fields.y.types == null;
  })());
  t('items 归一', JSON.stringify(sc.fields.tags.items) === '["string"]');
  t('声明同时 required+default 报错', (() => { try { normalizeSchema({ x: { type: 'string', required: true, default: 1 } }); return false; } catch { return true; } })());

  deepEq(checkDoc({ title: 'a', views: 3, tags: ['x'], note: null }, sc), [], '合法文档无错误');
  t('类型不符报错', checkDoc({ title: 'a', views: '3' }, sc).some((e) => e.includes('views')));
  t('必填缺失报错', checkDoc({ views: 1 }, sc).some((e) => e.includes('title')));
  t('元素类型不符报错', checkDoc({ title: 'a', tags: [1] }, sc).some((e) => e.includes('元素')));
  t('未知字段默认 reject', checkDoc({ title: 'a', extra: 1 }, sc).some((e) => e.includes('未知字段 extra')));
  t('可选字段 null 合法(无需声明)', !checkDoc({ title: 'a', note: null }, sc).length);
  t('required 字段 null 被拒', checkDoc({ title: null }, sc).some((e) => e.includes('不能为 null')));
});

/* ---------- strict 模式 ---------- */
section('strict:写入校验 / extra 策略 / default', async () => {
  const db = await newDb('strict1');
  await db.createCollection('t', {
    schema: {
      title: { type: 'string', required: true },
      views: { type: 'number', default: 0 },
      tags: { type: 'array', items: 'string' },
    },
  });
  const col = db.collection('t');
  await col.insert({ title: 'a', views: 5, tags: ['x'] });
  t('合法插入成功', (await col.count()) === 1);

  await assert.rejects(() => col.insert({ title: 1 }), (e) => /schema 校验失败/.test(e.message) && /title/.test(e.message), '类型不符被拒');
  t('失败后集合未受污染', (await col.count()) === 1);

  await assert.rejects(() => col.insert({ views: 1 }), (e) => /title/.test(e.message), '必填缺失被拒');

  const doc = await col.insert({ title: 'b' });
  deepEq(doc.views, 0, 'default 自动补齐');

  await col.update(doc.id, { views: 'x' }).catch(() => {});
  await assert.rejects(() => col.update(doc.id, { views: 'x' }), /views/, 'update 合并结果校验');
  deepEq((await col.get(doc.id)).views, 0, '失败 update 未落盘');

  await col.update(doc.id, { views: 9 });
  deepEq((await col.get(doc.id)).views, 9, '合法 update 落盘');

  /* extra: strip */
  const db2 = await newDb('strict2');
  const col2 = await db2.createCollection('s', { schema: { known: 'number' }, extra: 'strip' });
  const stripped = await col2.insert({ known: 1, junk: 'x' });
  t('strip 剥掉未知字段', stripped.known === 1 && stripped.junk === undefined && Object.keys(stripped).length === 2, JSON.stringify(stripped));
});

/* ---------- auto 模式:吸收演化 ---------- */
section('auto:未知字段吸收 / 类型放宽 / 同事务落盘', async () => {
  const be = createMemoryBackend();
  const db = await open('auto1', { storage: be });
  const col = db.collection('t');
  await col.insert({ title: 'a', views: 1 });
  /* 无 schema 时随便插 —— auto 从 createCollection 起 */
  t('无 schema 不拦截', (await col.count()) === 1);

  const db2 = await open('auto2', { storage: be });
  const c2 = await db2.createCollection('t2', { mode: 'auto', schema: { title: 'string' } });
  await c2.insert({ title: 'a', views: 5, tags: ['x'] });
  const after = await c2.findOne({ title: 'a' });
  t('吸收后文档完整保留', after.views === 5 && JSON.stringify(after.tags) === '["x"]');
  const sc = db2._cat.cols.t2.schema;
  t('views 吸收为 number 可选', JSON.stringify(sc.fields.views?.types) === '["number"]');
  t('tags 吸收为 array + items string', sc.fields.tags?.types[0] === 'array' && JSON.stringify(sc.fields.tags.items) === '["string"]');

  await c2.insert({ title: 'b', views: null });
  t('可选字段 null 合法且类型不变', JSON.stringify(db2._cat.cols.t2.schema.fields.views.types) === '["number"]');

  await assert.rejects(() => c2.insert({ title: 'c', views: 'many' }), /不放宽/, '类型冲突报错(auto 不放宽联合)');
  t('失败后类型未被放宽', JSON.stringify(db2._cat.cols.t2.schema.fields.views.types) === '["number"]');

  await assert.rejects(() => c2.insert({ title: 'd', tags: ['a', 1] }), /元素/, '元素类型冲突报错(不放弃 items)');
  t('items 约束仍在', JSON.stringify(db2._cat.cols.t2.schema.fields.tags.items) === '["string"]');
  t('失败写入未落盘', (await c2.count()) === 2);

  /* 落盘:同一 backend 重开,schema 演化结果仍在 */
  db2.close();
  const db3 = await open('auto2', { storage: be });
  const sc3 = db3._cat.cols.t2.schema;
  t('重开后 schema 演化仍在', JSON.stringify(sc3.fields.views.types) === '["number"]' && JSON.stringify(sc3.fields.tags.items) === '["string"]');

  /* insert 失败 → schema 回退(内存 + 磁盘):
   * 同一次失败写入里 bonus(新字段)先被吸收、views(类型冲突)后报错 —— 吸收必须整体撤销 */
  const beR = createMemoryBackend();
  const dbR = await open('rollback1', { storage: beR });
  const cR = await dbR.createCollection('t', { mode: 'auto', schema: { title: 'string', views: 'number' } });
  await cR.insert({ title: 'ok', views: 1 });
  await cR.insert({ title: 'bad', views: 'x', bonus: 9 }).catch(() => {});
  t('失败写入内存 schema 已回退', dbR._cat.cols.t.schema.fields.bonus == null
    && JSON.stringify(dbR._cat.cols.t.schema.fields.views.types) === '["number"]');
  dbR.close();
  const dbR2 = await open('rollback1', { storage: beR });
  t('失败写入磁盘 schema 无吸收痕迹(重开验证)', dbR2._cat.cols.t.schema.fields.bonus == null
    && JSON.stringify(dbR2._cat.cols.t.schema.fields.views.types) === '["number"]');
  deepEq(await dbR2.collection('t').find().then((l) => l.length), 1, '失败文档未落盘');
  /* 回退后正常吸收仍可用 */
  await dbR2.collection('t').insert({ title: 'again', bonus: 3 });
  t('回退后新字段仍可正常吸收', dbR2._cat.cols.t.schema.fields.bonus != null);

  /* auto 模式下 required/default 仍生效 */
  const db4 = await newDb('auto4');
  const c4 = await db4.createCollection('r', { mode: 'auto', schema: { title: { type: 'string', required: true }, views: { type: 'number', default: 0 } } });
  await assert.rejects(() => c4.insert({ views: 1 }), /title/, 'auto 模式必填仍拦截');
  await assert.rejects(() => c4.insert({ title: null }), /null/, 'auto 模式 required 字段 null 拦截');
  const d4 = await c4.insert({ title: 'x' });
  t('auto 模式 default 仍补齐', d4.views === 0);

  /* 吸收时值为 null 的字段:类型未知,首见实际值学习 */
  const db5 = await newDb('auto5');
  const c5 = await db5.createCollection('l', { mode: 'auto', schema: { title: 'string' } });
  await c5.insert({ title: 'n', mystery: null });
  t('null 值字段吸收为未知类型', db5._cat.cols.l.schema.fields.mystery?.types == null);
  await c5.insert({ title: 'm', mystery: 42 });
  t('首见实际值学习类型', JSON.stringify(db5._cat.cols.l.schema.fields.mystery.types) === '["number"]');
  await assert.rejects(() => c5.insert({ title: 'k', mystery: 'str' }), /不放宽/, '学习后的类型不放宽');
});

/* ---------- createCollection / setSchema ---------- */
section('createCollection / setSchema', async () => {
  const db = await newDb('cc1');
  const c = await db.createCollection('t', { schema: { a: 'number' } });
  t('返回 Collection 句柄', typeof c.insert === 'function');
  deepEq(await db.listCollections(), ['t'], '空集合已落盘');

  await db.createCollection('t');  // 幂等
  deepEq(await db.listCollections(), ['t'], '幂等不重复建');

  await c.insert({ a: 1 });
  await assert.rejects(() => db.collection('t').insert({ a: 'x' }), /a/, 'createCollection 的 schema 生效');

  /* setSchema:宽松追加可选字段 */
  const col = db.collection('t');
  const scanned = await col.setSchema({ a: 'number', b: 'string' });
  t('setSchema 扫描存量', scanned === 1);
  await col.insert({ a: 2, b: 'x' });

  /* setSchema:存量不符即拒绝 */
  await col.insert({ a: 3, b: 'y' });
  await assert.rejects(() => col.setSchema({ a: 'number', b: { type: 'number', required: true } }), /b/, '存量不符时 setSchema 报错回滚');

  /* scan: false 跳过扫描 */
  const skipped = await col.setSchema({ a: 'number', c: 'boolean' }, { scan: false });
  t('scan:false 不扫描', skipped === 0);

  /* 移除 schema */
  await col.setSchema(null);
  const free = await col.insert({ anything: true });
  t('移除 schema 后不再校验', free.anything === true);
});

/* ---------- migrateSchema ---------- */
section('migrateSchema:变换 + 校验 + 版本', async () => {
  const db = await newDb('mig1');
  const col = db.collection('t');
  await col.insertMany([
    { id: 'u1', name: 'a', viewCount: 3 },
    { id: 'u2', name: 'b', viewCount: null },
  ]);
  const n = await col.migrateSchema({
    fields: { name: { type: 'string', required: true }, views: { type: ['number', 'null'] } },
    version: 2,
    run: (d) => ({ name: d.name, views: d.viewCount ?? 0 }),
  });
  t('迁移行数', n === 2);
  t('版本记录', db._cat.cols.t.schemaV === 2);
  deepEq((await col.get('u1')).views, 3, 'run 变换生效');
  deepEq((await col.get('u2')).views, 0, '缺省填充');
  await assert.rejects(
    () => col.insert({ name: 'c', views: 'x' }),
    /views/,
    '迁移后新 schema 生效',
  );

  /* run 产出不合 schema → 整体回滚 */
  await col.insert({ id: 'u3', name: 'c', views: 9 });
  await assert.rejects(
    () => col.migrateSchema({ fields: { name: 'string' }, run: () => ({ oops: 1 }) }),
    /oops/,
    '迁移产物校验失败',
  );
  t('回滚后原数据完好', (await col.get('u3')) != null && (await col.count()) === 3);
});

/* ---------- 物化与失效 ---------- */
section('loadAll 物化 / 失效 / find 一致性', async () => {
  const db = await newDb('mat1');
  const col = db.collection('t');
  await col.insertMany([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }]);

  const mat = await col.loadAll();
  t('物化数组长度', mat.length === 3);
  deepEq(await col.find((d) => d.n > 1), [{ id: 'b', n: 2 }, { id: 'c', n: 3 }], '物化路径 find 函数过滤');

  const ret = await col.find();
  ret[0].n = 999;
  deepEq((await col.loadAll())[0].n, 1, 'find 返回深拷贝,不污染物化');

  await col.insert({ id: 'd', n: 4 });
  deepEq((await col.find()).length, 4, '写入后物化失效,find 看到新数据');

  await col.remove('a');
  deepEq((await col.count((d) => d.n > 0)), 3, 'remove 后 count 正确');
});

/* ---------- 运行 ---------- */
let ran = 0;
for (const s of sections) {
  const before = fail;
  try {
    await s.fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ [${s.name}] 异常: ${e.message}`);
  }
  ran++;
  if (fail > before) console.log(`(section: ${s.name})`);
}
console.log(`\nschema 测试:${pass} 通过,${fail} 失败,共 ${ran} 组`);
process.exit(fail ? 1 : 0);
