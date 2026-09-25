/* AetherWebDatabase 测试:CRUD / 原子回滚 / 页级加密 / 单例串行 / 导入导出 / 大文档跨页。
 *
 * 运行:node test/db-test.mjs
 *
 * 库不直连 OPFS。主路径:Node 模拟 webos VFS(mock-webos-fs)+ createFileBackend
 * (与生产 appdata 相同的字符串文件后端);另保留 memory 后端做对照。
 */
import assert from 'node:assert';
import {
  open,
  closeAll,
  createMemoryBackend,
  createFileBackend,
  PAGE_SIZE,
  decodeSuper,
} from '../src/index.js';
import { createMockWebosFs } from './mock-webos-fs.mjs';

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
const eq = (got, want, msg) =>
  t(msg, got === want, `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);
const deepEq = (got, want, msg) =>
  t(msg, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);

/**
 * 模拟 webos 文件库:独立 mock FS + .awdb 路径 + createFileBackend。
 * @returns {{ fs: object, path: string, storage: object }}
 */
function fileDb(name = 'test') {
  const fs = createMockWebosFs();
  fs.mkdir('/home/u/appdata');
  const path = `/home/u/appdata/${name}.awdb`;
  const storage = createFileBackend(fs, path);
  return { fs, path, storage };
}

const mem = () => createMemoryBackend();

/** 读槽 0/1 超级块(断言用) */
async function supers(storage) {
  const a = decodeSuper(await storage.readPage(0));
  const b = decodeSuper(await storage.readPage(1));
  return { a, b };
}

/* ---------- open / 单例 ---------- */
section('open / 单例', async () => {
  const { storage, path, fs } = fileDb('db1');
  const a = await open('db1', { storage });
  const b = await open('db1', { storage });
  t('同名 open 返回同一句柄', a === b);

  const other = fileDb('db2');
  const c = await open('db2', { storage: other.storage });
  t('不同名是不同句柄', a !== c);

  const [p1, p2, p3] = await Promise.all([
    open('race', { storage }),
    open('race', { storage }),
    open('race', { storage }),
  ]);
  t('并发 open 单例', p1 === p2 && p2 === p3);

  const col = a.collection('x');
  await col.insert({ n: 1 });
  a.close();
  const a2 = await open('db1', { storage });
  t('close 后重开是新句柄', a2 !== a);
  eq(await a2.collection('x').count(), 1, '重开后数据仍在');

  const { a: sa, b: sb } = await supers(storage);
  t('至少一个合法超级块', !!(sa || sb));
  t('超级块分页尺寸 4096', (sa || sb).pageSize === PAGE_SIZE);

  // 落在模拟 VFS 的 .awdb:二进制字节,不再 base64 包装
  t('文件路径带 .awdb', path.endsWith('.awdb'));
  const raw = fs.readBinary(path);
  t('落盘为二进制页文件', raw instanceof Uint8Array && raw.length > 0);
  t('非 base64 字符串', typeof fs.read(path) !== 'string');

  // 对齐 webos inode 拆分:元数据无 d,内容独立存放
  const metaNode = fs.dumpMeta()[path];
  t('元数据节点存在', !!metaNode);
  t('元数据无内联内容 d', metaNode && metaNode.d === undefined);
  t('内容在独立存储', Object.keys(fs.dumpContents()).includes(path));
  t('isDir/exists 对齐', fs.isDir('/home/u/appdata') && fs.exists(path) && !fs.isDir(path));
});

/* ---------- CRUD ---------- */
section('CRUD', async () => {
  const { storage } = fileDb('crud');
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

  const all = await msgs.find();
  eq(all.length, 5, 'find 全量');

  const hit = await msgs.find({ text: '指定 id' });
  eq(hit.length, 1, '对象 filter');
  eq(hit[0].id, 'fixed', 'filter 命中 id');

  const pred = await msgs.find((d) => d.text === 'a' || d.text === 'b');
  eq(pred.length, 2, '函数 filter');

  eq((await msgs.findOne({ text: 'a' }))?.id != null, true, 'findOne');
  eq(await msgs.count({ text: 'a' }), 1, 'count+filter');

  const sorted = await msgs.find(null, { sort: { text: 1 } });
  const texts = sorted.map((d) => d.text);
  deepEq(texts, [...texts].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), 'sort 升序');
  eq((await msgs.find(null, { limit: 2 })).length, 2, 'limit');
  eq((await msgs.find(null, { offset: 3 })).length, 2, 'offset');

  const upd = await msgs.update('fixed', { text: '已改', extra: 1 });
  eq(upd.text, '已改', 'update 后内容');
  eq(upd.extra, 1, 'update 浅合并新字段');
  eq(await msgs.update('missing', { text: 'x' }), null, 'update 不存在');
  eq((await msgs.update('fixed', { id: 'hacked' })).id, 'fixed', 'patch 不能改 id');

  const nUpd = await msgs.updateWhere({ text: 'a' }, { unread: false });
  eq(nUpd, 1, 'updateWhere 条数');
  eq((await msgs.findOne({ text: 'a' })).unread, false, 'updateWhere 生效');

  eq(await msgs.remove('fixed'), true, 'remove 存在');
  eq(await msgs.remove('fixed'), false, 'remove 幂等');
  eq(await msgs.removeWhere({ text: 'b' }), 1, 'removeWhere');
  eq(await msgs.count(), 3, '删后条数');

  const snapshot = await msgs.find();
  snapshot.forEach((d) => { d.text = 'MUTATED'; });
  eq((await msgs.find()).every((d) => d.text !== 'MUTATED'), true, 'find 返回独立副本');

  await msgs.clear();
  eq(await msgs.count(), 0, 'clear');
  eq((await msgs.insert({ text: 'x' })).id != null, true, 'clear 后仍可插入');
  await db.dropCollection('messages');
  deepEq(await db.listCollections(), [], 'dropCollection');
  eq(await db.collection('messages').count(), 0, '删集合后 count 0');
});

/* ---------- 原子性 ---------- */
section('单条指令原子性', async () => {
  const { storage, fs } = fileDb('atomic');
  const db = await open('atomic', { storage });
  const c = db.collection('t');
  await c.insert({ id: '1', n: 1 });
  await c.insert({ id: '2', n: 2 });

  fs.failWrites = true;
  await assert.rejects(() => c.insert({ id: '3', n: 3 }), /write failed/);
  fs.failWrites = false;

  eq(await c.count(), 2, '失败插入未进入内存');
  eq(await c.get('3'), null, '失败 id 不可见');
  const ok = await c.insert({ id: '4', n: 4 });
  eq(ok.id, '4', '失败后队列恢复');

  const before = await c.get('1');
  fs.failWrites = true;
  await assert.rejects(() => c.update('1', { n: 999 }), /write failed/);
  fs.failWrites = false;
  eq((await c.get('1')).n, before.n, 'update 失败内存回滚');

  fs.failWrites = true;
  await assert.rejects(() => c.remove('2'), /write failed/);
  fs.failWrites = false;
  eq((await c.get('2')) != null, true, 'remove 失败内存回滚');

  const { a, b } = await supers(storage);
  const live = a && b ? (a.generation >= b.generation ? a : b) : a || b;
  t('失败后仍有合法超级块', !!live);
  eq(await c.count() >= 2, true, '回滚后读正常');
});

/* ---------- 页级加密 ---------- */
section('页级加密', async () => {
  const { storage, fs } = fileDb('secret');
  const db = await open('secret', { storage, password: 'pw123' });
  t('句柄报告 encrypted', db.encrypted);

  const col = db.collection('kv');
  await col.insert({ id: 'k', v: '敏感数据' });

  // 落盘为原始字节(无 base64);数据页不应出现明文
  const fileBytes = fs.readBinary(`/home/u/appdata/secret.awdb`);
  t('文件为 Uint8Array', fileBytes instanceof Uint8Array && fileBytes.length > 0);
  let plainLeak = false;
  if (fileBytes) {
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(fileBytes);
    if (asText.includes('敏感数据')) plainLeak = true;
  }
  t('整库字节内无明文', !plainLeak);

  const pageCount = await storage.pageCount();
  let pageLeak = false;
  for (let i = 2; i < Math.min(pageCount, 8); i++) {
    const page = await storage.readPage(i);
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(page);
    if (asText.includes('敏感数据')) pageLeak = true;
  }
  t('数据页无明文泄漏', !pageLeak);

  const { a, b } = await supers(storage);
  const live = a && b ? (a.generation >= b.generation ? a : b) : a || b;
  t('超级块标记 encrypted', live.encrypted === 1);

  db.close();
  const db2 = await open('secret', { storage, password: 'pw123' });
  eq((await db2.collection('kv').get('k')).v, '敏感数据', '解密读回');

  db2.close();
  await assert.rejects(
    () => open('secret', { storage, password: 'wrong' }),
    /密码错误|损坏/,
    '错误密码',
  );
  await assert.rejects(() => open('secret', { storage }), /需要密码/, '缺密码');

  const plain = fileDb('up');
  const p1 = await open('up', { storage: plain.storage });
  await p1.collection('a').insert({ n: 1 });
  p1.close();
  const p2 = await open('up', { storage: plain.storage, password: 'newpw' });
  t('升级后 encrypted', p2.encrypted);
  const { a: sa } = await supers(plain.storage);
  t('超级块已标记加密', sa?.encrypted === 1);
  eq(await p2.collection('a').count(), 1, '升级后数据仍在');

  await p2.setPassword('pw2');
  p2.close();
  const p3 = await open('up', { storage: plain.storage, password: 'pw2' });
  eq(await p3.collection('a').count(), 1, '换密后可读');

  await assert.rejects(
    () => open('up', { storage: plain.storage, password: 'other' }),
    /其他密码/,
    '换密码 open 拒绝',
  );

  await p3.setPassword(null);
  const { a: sa3, b: sb3 } = await supers(plain.storage);
  const live3 = sa3 && sb3
    ? (sa3.generation >= sb3.generation ? sa3 : sb3)
    : (sa3 || sb3);
  t('setPassword(null) 后超级块明文', !!live3 && live3.encrypted === 0);
});

/* ---------- 串行与交错 ---------- */
section('同库串行 / 异库独立', async () => {
  const { storage } = fileDb('ser');
  const db = await open('ser', { storage, password: 'p' });
  const c = db.collection('n');

  const ops = [];
  for (let i = 0; i < 20; i++) ops.push(c.insert({ i }));
  const results = await Promise.all(ops);
  eq(results.length, 20, '并发 insert 全部完成');
  eq(await c.count(), 20, '并发后计数 20');
  eq(new Set(results.map((r) => r.id)).size, 20, 'id 无碰撞');

  // 同一 mock FS 上两个不同 .awdb 文件
  const fsShared = createMockWebosFs();
  fsShared.mkdir('/home/u/appdata');
  const beA = createFileBackend(fsShared, '/home/u/appdata/A.awdb');
  const beB = createFileBackend(fsShared, '/home/u/appdata/B.awdb');
  const d1 = await open('A', { storage: beA });
  const d2 = await open('B', { storage: beB });
  await Promise.all([
    d1.collection('c').insert({ x: 1 }),
    d2.collection('c').insert({ x: 2 }),
  ]);
  eq(await d1.collection('c').count(), 1, 'A 独立');
  eq(await d2.collection('c').count(), 1, 'B 独立');
  t('两个 .awdb 文件都在', fsShared.allFiles().filter((p) => p.endsWith('.awdb')).length >= 2);
});

/* ---------- 跨页大文档 ---------- */
section('大文档跨页', async () => {
  const { storage } = fileDb('big');
  const db = await open('big', { storage });
  const col = db.collection('blob');
  const big = 'x'.repeat(PAGE_SIZE * 3 + 123);
  const d = await col.insert({ id: 'big', data: big });
  eq(d.data.length, big.length, '写入长度');
  const back = await col.get('big');
  eq(back.data.length, big.length, '读回长度');
  eq(back.data, big, '跨页内容一致');

  const enc = fileDb('bigenc');
  const edb = await open('bigenc', { storage: enc.storage, password: 'pw' });
  const ecol = edb.collection('blob');
  const ebig = 'y'.repeat(4068 * 2 + 50);
  await ecol.insert({ id: 'e', data: ebig });
  eq((await ecol.get('e')).data, ebig, '加密跨页一致');
});

/* ---------- 导入导出 ---------- */
section('export / import', async () => {
  const { storage } = fileDb('io');
  const db = await open('io', { storage });
  await db.collection('c').insert({ id: '1', v: 'keep' });
  const json = await db.exportJSON();
  t('export 是 JSON 且含文档', typeof json === 'string' && json.includes('keep'));

  await db.collection('c').clear();
  eq(await db.collection('c').count(), 0, 'clear 后 0');

  await db.importJSON(json);
  eq((await db.collection('c').get('1'))?.v, 'keep', 'import 恢复');

  await assert.rejects(() => db.importJSON('{"v":99,"cols":{}}'), /无效的库导出/, '坏格式拒绝');
  eq((await db.collection('c').get('1'))?.v, 'keep', '坏 import 不破坏数据');
});

/* ---------- drop ---------- */
section('drop', async () => {
  const { storage } = fileDb('gone');
  const db = await open('gone', { storage, password: 'z' });
  await db.collection('c').insert({ n: 1 });
  await db.drop();
  t('drop 后句柄关闭', db.closed);

  const db2 = await open('gone', { storage });
  eq(db2.encrypted, false, 'drop 后新库无密码');
  eq(await db2.collection('c').count(), 0, 'drop 后是空库');
});

/* ---------- SMS 场景 ---------- */
section('短信场景冒烟', async () => {
  const { storage } = fileDb('sms');
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
  eq((await db2.collection('messages').get(m.id))?.text, '验证码 123456', '重启后消息仍在');
});

/* ---------- memory 对照 ---------- */
section('memory 后端对照', async () => {
  const storage = mem();
  const db = await open('memonly', { storage });
  await db.collection('t').insert({ n: 1 });
  eq(await db.collection('t').count(), 1, 'memory CRUD');

  storage.failWrites = true;
  await assert.rejects(() => db.collection('t').insert({ n: 2 }), /write failed/, 'memory 写失败');
  storage.failWrites = false;
  eq(await db.collection('t').count(), 1, 'memory 失败回滚');
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

console.log(`\n====== AetherWebDatabase(paged+vfs): ${pass} pass, ${fail} fail ======`);
process.exit(fail ? 1 : 0);
