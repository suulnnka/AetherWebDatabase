/* AetherWebDatabase 测试:CRUD / 原子回滚 / 加密 / 单例串行 / 导入导出。
 *
 * 运行:node test/db-test.mjs
 */
import assert from 'node:assert';
import {
  open,
  closeAll,
  memoryStorage,
  isEncrypted,
} from '../src/index.js';

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
const eq = (got, want, msg) => t(msg, got === want, `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);
const deepEq = (got, want, msg) =>
  t(msg, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);

/** 每节独立 storage,互不串档 */
const mem = () => memoryStorage();

/* ---------- 打开 / 单例 ---------- */
section('open / 单例', async () => {
  const storage = mem();
  const a = await open('db1', { storage });
  const b = await open('db1', { storage });
  t('同名 open 返回同一句柄', a === b);

  const c = await open('db2', { storage });
  t('不同名是不同句柄', a !== c);

  // 并发 open 只建一份
  const [p1, p2, p3] = await Promise.all([
    open('race', { storage }),
    open('race', { storage }),
    open('race', { storage }),
  ]);
  t('并发 open 单例', p1 === p2 && p2 === p3);

  // 关闭后可重开,数据仍在
  const col = a.collection('x');
  await col.insert({ n: 1 });
  a.close();
  const a2 = await open('db1', { storage });
  t('close 后重开是新句柄', a2 !== a);
  eq(await a2.collection('x').count(), 1, '重开后数据仍在');

  // 持久化在 storage
  const keys = Object.keys(storage.dump());
  t('落盘键为 awdb.*', keys.every((k) => k.startsWith('awdb.')), keys.join(','));
});

/* ---------- CRUD ---------- */
section('CRUD', async () => {
  const storage = mem();
  const db = await open('crud', { storage });
  const msgs = db.collection('messages');

  const m1 = await msgs.insert({ text: '你好', unread: true });
  t('insert 返回带 id', typeof m1.id === 'string' && m1.id.length > 0);
  eq(m1.text, '你好', 'insert 内容');

  const m2 = await msgs.insert({ id: 'fixed', text: '指定 id' });
  eq(m2.id, 'fixed', '显式 id');

  await assert.rejects(() => msgs.insert({ id: 'fixed' }), /id 已存在/, '重复 id 拒绝');
  eq(await msgs.count(), 2, '拒绝后仍 2 条');

  eq((await msgs.get('fixed')).text, '指定 id', 'get');
  eq(await msgs.get('nope'), null, 'get 不存在');

  const many = await msgs.insertMany([{ text: 'a' }, { text: 'b' }, { id: 'm3', text: 'c' }]);
  eq(many.length, 3, 'insertMany 条数');
  eq(await msgs.count(), 5, '总数 5');

  await assert.rejects(
    () => msgs.insertMany([{ text: 'x' }, { id: 'fixed', text: 'dup' }]),
    /id 已存在/,
    'insertMany 撞 id 全回滚',
  );
  eq(await msgs.count(), 5, 'insertMany 失败未写入');

  // find
  const all = await msgs.find();
  eq(all.length, 5, 'find 全量');

  const hit = await msgs.find({ text: '指定 id' });
  eq(hit.length, 1, '对象 filter');
  eq(hit[0].id, 'fixed', 'filter 命中 id');

  const pred = await msgs.find((d) => d.text === 'a' || d.text === 'b');
  eq(pred.length, 2, '函数 filter');

  eq((await msgs.findOne({ text: 'a' }))?.id != null, true, 'findOne');
  eq(await msgs.count({ text: 'a' }), 1, 'count+filter');

  // sort / limit / offset(排序用码元序,与实现一致)
  const sorted = await msgs.find(null, { sort: { text: 1 } });
  const texts = sorted.map((d) => d.text);
  deepEq(texts, [...texts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'sort 升序');
  eq((await msgs.find(null, { limit: 2 })).length, 2, 'limit');
  eq((await msgs.find(null, { offset: 3 })).length, 2, 'offset');

  // update
  const upd = await msgs.update('fixed', { text: '已改', extra: 1 });
  eq(upd.text, '已改', 'update 后内容');
  eq(upd.extra, 1, 'update 浅合并新字段');
  eq(await msgs.update('missing', { text: 'x' }), null, 'update 不存在');
  eq((await msgs.update('fixed', { id: 'hacked' })).id, 'fixed', 'patch 不能改 id');

  const nUpd = await msgs.updateWhere({ text: 'a' }, { unread: false });
  eq(nUpd, 1, 'updateWhere 条数');
  eq((await msgs.findOne({ text: 'a' })).unread, false, 'updateWhere 生效');

  // remove
  eq(await msgs.remove('fixed'), true, 'remove 存在');
  eq(await msgs.remove('fixed'), false, 'remove 幂等');
  eq(await msgs.removeWhere({ text: 'b' }), 1, 'removeWhere');
  eq(await msgs.count(), 3, '删后条数');

  // 返回值是副本:改返回值不影响库
  const before = await msgs.count();
  const snapshot = await msgs.find();
  snapshot.forEach((d) => { d.text = 'MUTATED'; });
  eq((await msgs.find()).every((d) => d.text !== 'MUTATED'), true, 'find 返回深拷贝');

  // clear / dropCollection
  await msgs.clear();
  eq(await msgs.count(), 0, 'clear');
  eq(await msgs.insert({ text: 'x' }).then((d) => d.id != null), true, 'clear 后仍可插入');
  await db.dropCollection('messages');
  deepEq(await db.listCollections(), [], 'dropCollection');
  eq(await db.collection('messages').count(), 0, '删集合后 count 0');
  void before;
});

/* ---------- 原子性 ---------- */
section('单条指令原子性', async () => {
  const storage = mem();
  const db = await open('atomic', { storage });
  const c = db.collection('t');
  await c.insert({ id: '1', n: 1 });
  await c.insert({ id: '2', n: 2 });

  // 落盘失败 → 内存回滚
  storage.failWrites = true;
  await assert.rejects(() => c.insert({ id: '3', n: 3 }), /write failed/);
  storage.failWrites = false;

  eq(await c.count(), 2, '失败插入未进入内存');
  eq(await c.get('3'), null, '失败 id 不可见');
  // 后续操作仍可用(队列未卡死)
  const ok = await c.insert({ id: '4', n: 4 });
  eq(ok.id, '4', '失败后队列恢复');

  // update 失败回滚
  const before = await c.get('1');
  storage.failWrites = true;
  await assert.rejects(() => c.update('1', { n: 999 }), /write failed/);
  storage.failWrites = false;
  eq((await c.get('1')).n, before.n, 'update 失败内存回滚');

  // remove 失败回滚
  storage.failWrites = true;
  await assert.rejects(() => c.remove('2'), /write failed/);
  storage.failWrites = false;
  eq(await c.get('2') != null, true, 'remove 失败内存回滚');

  // 读不受 failWrites 影响
  eq(await c.count() >= 2, true, '回滚后读正常');
});

/* ---------- 加密 ---------- */
section('加密', async () => {
  const storage = mem();
  const db = await open('secret', { storage, password: 'pw123' });
  t('句柄报告 encrypted', db.encrypted);
  const col = db.collection('kv');
  await col.insert({ id: 'k', v: '敏感数据' });

  const raw = storage.dump()['awdb.secret'];
  t('落盘为加密串', isEncrypted(raw), String(raw).slice(0, 40));
  t('明文不可见', !String(raw).includes('敏感数据'));

  // 关闭重开:正确密码
  db.close();
  const db2 = await open('secret', { storage, password: 'pw123' });
  eq((await db2.collection('kv').get('k')).v, '敏感数据', '解密读回');

  // 错误密码
  db2.close();
  await assert.rejects(() => open('secret', { storage, password: 'wrong' }), /密码错误|损坏/, '错误密码');

  // 无密码打开加密库
  await assert.rejects(() => open('secret', { storage }), /需要密码/, '缺密码');

  // 明文库 + 密码 → 升级加密
  const plainStore = mem();
  const p1 = await open('up', { storage: plainStore });
  await p1.collection('a').insert({ n: 1 });
  p1.close();
  const p2 = await open('up', { storage: plainStore, password: 'newpw' });
  t('升级后 encrypted', p2.encrypted);
  t('落盘已加密', isEncrypted(plainStore.dump()['awdb.up']));
  eq(await p2.collection('a').count(), 1, '升级后数据仍在');

  // 换密 / 解密
  await p2.setPassword('pw2');
  p2.close();
  const p3 = await open('up', { storage: plainStore, password: 'pw2' });
  eq(await p3.collection('a').count(), 1, '换密后可读');

  // 句柄已用密码 A 打开,再 open 传 B → 拒绝(须在仍加密时)
  await assert.rejects(
    () => open('up', { storage: plainStore, password: 'other' }),
    /其他密码/,
    '换密码 open 拒绝',
  );

  await p3.setPassword(null);
  t('setPassword(null) 转明文', !isEncrypted(plainStore.dump()['awdb.up']));
});

/* ---------- 串行与交错 ---------- */
section('同库串行 / 异库独立', async () => {
  const storage = mem();
  const db = await open('ser', { storage, password: 'p' });
  const c = db.collection('n');

  // 一口气发 20 条 insert,全部应完成且计数正确
  const ops = [];
  for (let i = 0; i < 20; i++) ops.push(c.insert({ i }));
  const results = await Promise.all(ops);
  eq(results.length, 20, '并发 insert 全部完成');
  eq(await c.count(), 20, '并发后计数 20');
  const ids = new Set(results.map((r) => r.id));
  eq(ids.size, 20, 'id 无碰撞');

  // 不同库可并行 open 与写
  const s2 = mem();
  const d1 = await open('A', { storage: s2 });
  const d2 = await open('B', { storage: s2 });
  await Promise.all([
    d1.collection('c').insert({ x: 1 }),
    d2.collection('c').insert({ x: 2 }),
  ]);
  eq(await d1.collection('c').count(), 1, 'A 独立');
  eq(await d2.collection('c').count(), 1, 'B 独立');
});

/* ---------- 导入导出 ---------- */
section('export / import', async () => {
  const storage = mem();
  const db = await open('io', { storage });
  await db.collection('c').insert({ id: '1', v: 'keep' });
  const json = await db.exportJSON();
  t('export 是 JSON', typeof json === 'string' && json.includes('keep'));

  db.collection('c').clear();
  eq(await db.collection('c').count(), 0, 'clear 后 0');

  await db.importJSON(json);
  eq(await db.collection('c').get('1').then((d) => d?.v), 'keep', 'import 恢复');

  await assert.rejects(() => importJSONBad(db), /无效的库导出/, '坏格式拒绝');
  eq(await db.collection('c').count(), 1, '坏 import 不破坏数据');
});

async function importJSONBad(db) {
  const snapshotOps = db.importJSON('{"v":99,"cols":{}}');
  return snapshotOps;
}

/* ---------- drop ---------- */
section('drop', async () => {
  const storage = mem();
  const db = await open('gone', { storage, password: 'z' });
  await db.collection('c').insert({ n: 1 });
  await db.drop();
  t('drop 后句柄关闭', db.closed);
  t('存储键已删', storage.dump()['awdb.gone'] == null);

  const db2 = await open('gone', { storage });
  eq(await db2.collection('c').count(), 0, 'drop 后是空库');
  eq(db2.encrypted, false, 'drop 后新库无密码');
});

/* ---------- SMS 场景冒烟 ---------- */
section('短信场景冒烟', async () => {
  const storage = mem();
  const db = await open('sms', { storage, password: 'user-secret' });
  const chats = db.collection('chats');
  const msgs = db.collection('messages');

  const chat = await chats.insert({ addr: '10086', name: '中国移动', unread: 0 });
  const m = await msgs.insert({ chatId: chat.id, dir: 'in', text: '验证码 123456', date: Date.now() });
  await chats.update(chat.id, { unread: 1 });

  const list = await msgs.find({ chatId: chat.id }, { sort: { date: -1 }, limit: 20 });
  eq(list.length, 1, '会话消息');
  eq((await chats.get(chat.id)).unread, 1, '未读数');
  eq(await chats.count({ addr: '10086' }), 1, '按地址查会话');

  db.close();
  const db2 = await open('sms', { storage, password: 'user-secret' });
  eq(await db2.collection('messages').get(m.id).then((d) => d?.text), '验证码 123456', '重启后消息仍在');
});

/* ---------- 跑 ---------- */
closeAll();
for (const s of sections) {
  console.log(`\n# ${s.name}`);
  try {
    await s.fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ 未捕获: ${e && e.stack ? e.stack : e}`);
  }
}

console.log(`\n====== AetherWebDatabase: ${pass} pass, ${fail} fail ======`);
process.exit(fail ? 1 : 0);
