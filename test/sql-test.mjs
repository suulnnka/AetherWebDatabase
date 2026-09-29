/* AetherWebDatabase 测试:SQL SELECT 查询前端(物化执行 / join / 分组 / 子查询 / 基准)。
 *
 * 运行:node test/sql-test.mjs
 */
import assert from 'node:assert';
import { open, createMemoryBackend } from '../src/index.js';

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

const newDb = async (name) => open(name, { storage: createMemoryBackend() });

async function seedDb() {
  const db = await newDb('sql1');
  const authors = db.collection('authors');
  await authors.insertMany([
    { id: 'a1', name: '甲', level: 1 },
    { id: 'a2', name: '乙', level: 2 },
    { id: 'a3', name: '丙', level: 1 },
    { id: 'a4', name: '丁', level: 9 },
  ]);
  const entries = db.collection('entries');
  await entries.insertMany([
    { id: 'e1', title: 'Alpha', cat: 'physics', views: 10, authorId: 'a1', publishedAt: '2024-01-01' },
    { id: 'e2', title: 'Beta', cat: 'physics', views: 5, authorId: 'a1', publishedAt: null },
    { id: 'e3', title: 'Gamma', cat: 'math', views: 8, authorId: 'a2', publishedAt: '2024-02-01' },
    { id: 'e4', title: 'Delta', cat: 'math', views: null, authorId: 'a2', publishedAt: null },
    { id: 'e5', title: 'Epsilon', cat: 'physics', views: 3, authorId: 'a3', publishedAt: '2024-03-01' },
    { id: 'e6', title: 'Zeta', cat: 'bio', views: 12, authorId: 'a3', publishedAt: null },
    { id: 'e7', title: 'Eta', cat: null, views: 1, authorId: 'a1', publishedAt: null },
    { id: 'e8', title: 'Theta', cat: 'math', views: 8, authorId: 'a9', publishedAt: null },
    { id: 'e9', title: 'Iota', cat: 'physics', views: 5, authorId: 'a1', publishedAt: '2024-04-01' },
    { id: 'e10', title: 'Kappa', cat: 'bio', views: 20, authorId: 'a3', publishedAt: '2024-05-01' },
  ]);
  return db;
}

/* ---------- 基本查询 ---------- */
section('基本:投影 / WHERE / 参数 / 排序分页', async () => {
  const db = await seedDb();

  deepEq(
    await db.sql('SELECT title FROM entries WHERE cat = ? ORDER BY title', ['physics']),
    [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Epsilon' }, { title: 'Iota' }],
    '等值过滤 + 排序',
  );
  deepEq(
    (await db.sql('SELECT id FROM entries WHERE views > 5')).length,
    5,
    '比较运算(null 不参与)',
  );
  deepEq(
    await db.sql('SELECT title AS t FROM entries WHERE cat = ? AND views >= 5 ORDER BY t LIMIT 2', ['physics']),
    [{ t: 'Alpha' }, { t: 'Beta' }],
    'AND + 别名 + LIMIT',
  );
  deepEq(
    await db.sql('SELECT title FROM entries ORDER BY views DESC, title ASC LIMIT 3 OFFSET 1'),
    [{ title: 'Zeta' }, { title: 'Alpha' }, { title: 'Gamma' }],
    '多键排序 + OFFSET(null 恒最后)',
  );
  deepEq(
    await db.sql('SELECT title FROM entries ORDER BY views DESC LIMIT 100'),
    (await db.sql('SELECT title FROM entries ORDER BY views DESC')),
    'LIMIT 超总量',
  );
  const all = await db.sql('SELECT * FROM entries WHERE id = ?', ['e4']);
  deepEq(all, [{ id: 'e4', title: 'Delta', cat: 'math', views: null, authorId: 'a2', publishedAt: null }], 'SELECT * 单行');
  await assert.rejects(() => db.sql('SELECT id FROM entries WHERE cat = ?'), /参数/, '缺参数报错');
});

/* ---------- 谓词 ---------- */
section('谓词:LIKE / IN / BETWEEN / IS NULL / 三值', async () => {
  const db = await seedDb();
  deepEq((await db.sql("SELECT title FROM entries WHERE title LIKE '%a%' ORDER BY title")).length, 9, 'LIKE 包含 a');
  deepEq((await db.sql("SELECT title FROM entries WHERE title LIKE 'K%'")).length, 1, 'LIKE 前缀');
  deepEq((await db.sql("SELECT title FROM entries WHERE title NOT LIKE '%a%' ORDER BY title")),
    [{ title: 'Epsilon' }], 'NOT LIKE');
  deepEq((await db.sql("SELECT id FROM entries WHERE cat IN ('physics', 'math') ORDER BY id")).length, 7, 'IN 列表');
  deepEq((await db.sql('SELECT id FROM entries WHERE views BETWEEN 5 AND 10 ORDER BY id')).length, 5, 'BETWEEN(闭区间)');
  deepEq((await db.sql('SELECT id FROM entries WHERE publishedAt IS NULL ORDER BY id')).length, 5, 'IS NULL');
  deepEq((await db.sql('SELECT id FROM entries WHERE publishedAt IS NOT NULL AND cat IS NOT NULL ORDER BY id')).length, 5, 'IS NOT NULL 组合');
  deepEq((await db.sql('SELECT id FROM entries WHERE cat = ? OR views > 15 ORDER BY id', ['bio'])).length, 2, 'OR');
  deepEq((await db.sql('SELECT id FROM entries WHERE NOT (cat = ?) ORDER BY id', ['physics'])).length, 5, 'NOT(null 组排除)');
  deepEq((await db.sql('SELECT id FROM entries WHERE cat != ? ORDER BY id', ['physics'])).length, 5, '!= 对 null 同样排除');
});

/* ---------- JOIN ---------- */
section('JOIN:inner / left / 派生表再 join', async () => {
  const db = await seedDb();
  deepEq(
    (await db.sql('SELECT e.title, a.name FROM entries e JOIN authors a ON e.authorId = a.id WHERE a.level = 1')).length,
    7,
    'inner join + 过滤',
  );
  deepEq(
    await db.sql('SELECT e.title, a.name FROM entries e LEFT JOIN authors a ON e.authorId = a.id WHERE a.id IS NULL'),
    [{ title: 'Theta', name: null }],
    'left join 反连接(悬空 authorId)',
  );
  deepEq(
    (await db.sql('SELECT e.title FROM entries e INNER JOIN authors a ON e.authorId = a.id INNER JOIN (SELECT id FROM authors WHERE level = 1) f ON f.id = a.id')).length,
    7,
    '三表链(含派生表)',
  );
  deepEq(
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id JOIN (SELECT id, level FROM authors) f ON f.id = a.id AND f.level = a.level WHERE a.level = 1')).map((r) => r.title).sort(),
    ['Alpha', 'Beta', 'Epsilon', 'Eta', 'Iota', 'Kappa', 'Zeta'],
    '多键 ON(AND 等值)',
  );
});

/* ---------- 聚合 ---------- */
section('聚合:GROUP BY / HAVING / DISTINCT / 空表', async () => {
  const db = await seedDb();
  deepEq(
    await db.sql('SELECT cat, COUNT(*) AS n FROM entries GROUP BY cat ORDER BY cat'),
    [{ cat: 'bio', n: 2 }, { cat: 'math', n: 3 }, { cat: 'physics', n: 4 }, { cat: null, n: 1 }],
    '分组计数(null 自成组,排序恒后)',
  );
  deepEq(
    await db.sql('SELECT cat, COUNT(*) AS n FROM entries GROUP BY cat HAVING n > 2 ORDER BY n DESC'),
    [{ cat: 'physics', n: 4 }, { cat: 'math', n: 3 }],
    'HAVING 引用别名',
  );
  deepEq(
    await db.sql('SELECT cat, SUM(views) AS s FROM entries GROUP BY cat ORDER BY cat'),
    [{ cat: 'bio', s: 32 }, { cat: 'math', s: 16 }, { cat: 'physics', s: 23 }, { cat: null, s: 1 }],
    'SUM 跳过 null',
  );
  deepEq(
    await db.sql('SELECT COUNT(*) AS n, COUNT(views) AS nv, COUNT(DISTINCT authorId) AS na FROM entries'),
    [{ n: 10, nv: 9, na: 4 }],
    '整体聚合 / COUNT 列 / COUNT DISTINCT',
  );
  deepEq(
    await db.sql('SELECT AVG(views) AS a FROM entries WHERE cat = ?', ['physics']),
    [{ a: 5.75 }],
    'AVG',
  );
  deepEq(
    await db.sql('SELECT DISTINCT cat FROM entries ORDER BY cat'),
    [{ cat: 'bio' }, { cat: 'math' }, { cat: 'physics' }, { cat: null }],
    'DISTINCT',
  );
  deepEq(
    await db.sql('SELECT COUNT(*) AS n, MAX(views) AS mx FROM entries WHERE cat = ?', ['nope']),
    [{ n: 0, mx: null }],
    '空结果整体聚合(COUNT=0)',
  );
});

/* ---------- 子查询 ---------- */
section('子查询:IN / EXISTS / 相关标量 / 派生表', async () => {
  const db = await seedDb();
  deepEq(
    (await db.sql('SELECT title FROM entries WHERE authorId IN (SELECT id FROM authors WHERE level = 1) ORDER BY title')).length,
    7,
    '非相关 IN 子查询',
  );
  deepEq(
    await db.sql('SELECT a.name FROM authors a WHERE EXISTS (SELECT 1 FROM entries e WHERE e.authorId = a.id) ORDER BY a.name'),
    [{ name: '丙' }, { name: '乙' }, { name: '甲' }],
    '相关 EXISTS(hash 半连接)',
  );
  deepEq(
    await db.sql('SELECT a.name FROM authors a WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.authorId = a.id)'),
    [{ name: '丁' }],
    'NOT EXISTS(反连接)',
  );
  deepEq(
    await db.sql('SELECT a.name, (SELECT COUNT(*) FROM entries e WHERE e.authorId = a.id) AS n FROM authors a ORDER BY a.name'),
    [{ name: '丁', n: 0 }, { name: '丙', n: 3 }, { name: '乙', n: 2 }, { name: '甲', n: 4 }],
    '相关标量 COUNT(空组补 0)',
  );
  deepEq(
    await db.sql('SELECT t.cat, t.n FROM (SELECT cat, COUNT(*) AS n FROM entries GROUP BY cat) t WHERE t.n > 2 ORDER BY t.n DESC'),
    [{ cat: 'physics', n: 4 }, { cat: 'math', n: 3 }],
    'FROM 派生表',
  );
  deepEq(
    await db.sql('SELECT a.name, (SELECT MAX(e.views) FROM entries e WHERE e.authorId = a.id) AS mx FROM authors a WHERE a.id = ?', ['a2']),
    [{ name: '乙', mx: 8 }],
    '相关标量 MAX',
  );
  await db.sql('SELECT title FROM entries e WHERE EXISTS (SELECT 1 FROM entries x WHERE x.authorId = e.id)').then(
    () => t('EXISTS 常规执行', true),
    () => t('EXISTS 常规执行', false),
  );
});

/* ---------- 不支持路径 ---------- */
section('明确报错的用法', async () => {
  const db = await seedDb();
  const rejects = async (sql, re, name) => {
    try {
      await db.sql(sql);
      t(name, false, '未报错');
    } catch (e) {
      t(name, re.test(e.message), `消息: ${e.message}`);
    }
  };
  await rejects('SELECT a.name FROM authors a WHERE (SELECT COUNT(*) FROM entries e WHERE e.views > a.level) > 0', /等值/, '非等值相关报不支持');
  await rejects('SELECT a.name FROM authors a WHERE a.id NOT IN (SELECT e.authorId FROM entries e WHERE e.authorId = a.id)', /NOT IN/, '相关 NOT IN 报不支持');
  await rejects('SELECT e.title FROM entries e JOIN authors a ON e.views > a.level', /等值/, '非等值 JOIN ON 报不支持');
  await rejects('SELECT NOPE(x) FROM entries', /未知函数/, '未知函数');
  await rejects('SELECT FROM entries', /解析错误/, '语法错误');
  await rejects('SELECT id FROM entries WHERE cat = ?', /参数/, '参数不足');
});

/* ---------- 表达式与函数 ---------- */
section('表达式:算术 / 拼接 / 函数', async () => {
  const db = await seedDb();
  deepEq(
    await db.sql('SELECT title, views * 2 + 1 AS v FROM entries WHERE id = ?', ['e1']),
    [{ title: 'Alpha', v: 21 }],
    '算术',
  );
  deepEq(
    await db.sql("SELECT title || ' (' || COALESCE(cat, '?') || ')' AS label FROM entries WHERE id = 'e7'"),
    [{ label: 'Eta (?)' }],
    '|| 拼接 + COALESCE',
  );
  deepEq(
    await db.sql("SELECT LOWER(title) AS lo, LENGTH(title) AS n FROM entries WHERE id = 'e1'"),
    [{ lo: 'alpha', n: 5 }],
    'LOWER / LENGTH',
  );
  deepEq(
    await db.sql('SELECT ROUND(AVG(views), 2) AS a FROM entries'),
    [{ a: 8 }],
    'ROUND 包聚合',
  );
});

/* ---------- 物化交互 ---------- */
section('物化:首查触发 / 写后失效重建 / 只读共享', async () => {
  const db = await seedDb();
  deepEq((await db.sql('SELECT COUNT(*) AS n FROM entries'))[0].n, 10, '首查(物化)');
  t('物化缓存已建立', db._mat.has('entries'));
  await db.collection('entries').insert({ id: 'e11', title: 'Lambda', cat: 'bio', views: 2, authorId: 'a1', publishedAt: null });
  deepEq((await db.sql('SELECT COUNT(*) AS n FROM entries'))[0].n, 11, '写后失效,重建物化');
  /* 派生表/子查询共享同一物化 */
  deepEq(
    (await db.sql('SELECT COUNT(*) AS n FROM (SELECT id FROM entries) t'))[0].n,
    11,
    '派生表反映最新数据',
  );
});

/* ---------- 基准:5 万条 ---------- */
section('基准:5 万条 join / 聚合 / 相关子查询', async () => {
  const N = 50000;
  const A = 1000;
  const db = await newDb('bench');
  const authors = db.collection('authors');
  const au = [];
  for (let i = 0; i < A; i++) au.push({ id: `a${i}`, name: `author-${i}`, level: (i % 9) + 1 });
  await authors.insertMany(au);
  const entries = db.collection('entries');
  const es = new Array(N);
  for (let i = 0; i < N; i++) {
    es[i] = {
      id: `e${i}`,
      title: `title-${i % 9973}`,
      cat: `cat-${i % 10}`,
      views: (i * 7919) % 5000,
      authorId: `a${i % A}`,
      publishedAt: i % 3 === 0 ? null : `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    };
  }
  const t0 = performance.now();
  await entries.insertMany(es);
  const tIns = performance.now() - t0;

  const bench = async (name, sql, params) => {
    const s = performance.now();
    const rows = await db.sql(sql, params);
    const ms = performance.now() - s;
    return { name, ms, rows };
  };

  const r1 = await bench('首查物化(5万)', 'SELECT COUNT(*) AS n FROM entries');
  const r2 = await bench('热查询 COUNT', 'SELECT COUNT(*) AS n FROM entries');
  const r3 = await bench('过滤+排序+LIMIT', 'SELECT title FROM entries WHERE cat = ? ORDER BY views DESC LIMIT 100', ['cat-3']);
  const r4 = await bench('JOIN 5万×1千', 'SELECT COUNT(*) AS n FROM entries e JOIN authors a ON e.authorId = a.id');
  const r5 = await bench('GROUP BY(10组)', 'SELECT cat, COUNT(*) AS n, SUM(views) AS s FROM entries GROUP BY cat ORDER BY cat');
  const r6 = await bench('相关标量(1千外层)', 'SELECT a.name, (SELECT COUNT(*) FROM entries e WHERE e.authorId = a.id) AS n FROM authors a ORDER BY n DESC LIMIT 5');
  const r7 = await bench('EXISTS 半连接', 'SELECT COUNT(*) AS n FROM authors a WHERE EXISTS (SELECT 1 FROM entries e WHERE e.authorId = a.id)');

  console.log('\n  —— 基准(内存后端,明文)——');
  console.log(`  insertMany 5万条        ${tIns.toFixed(0)} ms`);
  for (const r of [r1, r2, r3, r4, r5, r6, r7]) {
    console.log(`  ${r.name.padEnd(22)} ${r.ms.toFixed(1).padStart(8)} ms   行数 ${r.rows.length}`);
  }

  t('join 计数正确', r4.rows[0].n === N, `得到 ${r4.rows[0].n}`);
  t('分组组数', r5.rows.length === 10);
  t('相关标量顶行计数 = 50', r6.rows[0].n === N / A, `得到 ${r6.rows[0].n}`);
  t('热查询显著快于首查(物化命中)', r2.ms < r1.ms || r1.ms < 50, `${r1.ms.toFixed(1)} → ${r2.ms.toFixed(1)}`);
});

/* ---------- 运行 ---------- */
let ran = 0;
for (const s of sections) {
  const before = fail;
  try {
    await s.fn();
  } catch (e) {
    fail++;
    console.log(`  ✗ [${s.name}] 异常: ${e.message}\n    ${e.stack?.split('\n')[1] ?? ''}`);
  }
  ran++;
  if (fail > before) console.log(`(section: ${s.name})`);
}
console.log(`\nSQL 测试:${pass} 通过,${fail} 失败,共 ${ran} 组`);
process.exit(fail ? 1 : 0);
