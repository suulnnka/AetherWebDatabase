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

/* ---------- 谓词下推 ---------- */
section('下推:语义等价 / LEFT 陷阱 / 裸列动态解析', async () => {
  const db = await seedDb();

  deepEq(
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id WHERE a.level = 1')).length,
    7,
    'inner:右侧谓词下推(结果不变)',
  );
  deepEq(
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id WHERE a.level = 1 AND e.cat = ?', ['physics'])).length,
    4,
    'inner:两侧谓词同时下推',
  );
  deepEq(
    (await db.sql('SELECT e.title FROM entries e LEFT JOIN authors a ON e.authorId = a.id WHERE e.cat = ?', ['bio'])).map((r) => r.title).sort(),
    ['Kappa', 'Zeta'],
    'left:外层侧谓词下推',
  );
  /* LEFT 右侧谓词不可下推:错误下推会让 Theta 的 null 扩展行凭空存活 */
  deepEq(
    await db.sql('SELECT e.title, a.name FROM entries e LEFT JOIN authors a ON e.authorId = a.id WHERE a.level = 2 ORDER BY e.title'),
    [{ title: 'Delta', name: '乙' }, { title: 'Gamma', name: '乙' }],
    'left:右侧谓词留在 join 后(仅实匹配行存活)',
  );
  deepEq(
    await db.sql('SELECT e.title FROM entries e LEFT JOIN authors a ON e.authorId = a.id WHERE a.id IS NULL'),
    [{ title: 'Theta' }],
    'left:右侧 IS NULL 反连接',
  );
  /* 三表:a 为 LEFT 右侧,其谓词在 f 进入前对积累行过滤 */
  deepEq(
    (await db.sql('SELECT e.title FROM entries e LEFT JOIN authors a ON e.authorId = a.id LEFT JOIN (SELECT id FROM authors WHERE level = 1) f ON f.id = a.id WHERE a.level = 1')).length,
    7,
    '多表:中层表谓词在下一层 join 前过滤',
  );
  /* 裸列多源不推:动态解析取第一个含该字段的源,下推会改变解析对象 */
  deepEq(
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id WHERE level = 1')).length,
    7,
    '裸列跨表:动态解析语义不变',
  );
  deepEq(
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id WHERE e.cat = ? OR a.level = 9 ORDER BY e.title', ['bio'])).map((r) => r.title),
    ['Kappa', 'Zeta'],
    '跨表 OR 整体留在 join 后',
  );
  deepEq(
    (await db.sql('SELECT DISTINCT e.cat FROM entries e JOIN authors a ON e.authorId = a.id WHERE e.views > 10 ORDER BY e.cat')),
    [{ cat: 'bio' }],
    '下推 + DISTINCT',
  );
  deepEq(
    (await db.sql('SELECT title FROM entries WHERE views > (SELECT AVG(views) FROM entries) ORDER BY title')).map((r) => r.title),
    ['Alpha', 'Kappa', 'Zeta'],
    '非相关子查询参与下推项(位置无关)',
  );
  deepEq(
    (await db.sql('SELECT a.name FROM authors a WHERE EXISTS (SELECT 1 FROM entries e WHERE e.authorId = a.id AND e.cat = ?) ORDER BY a.name', ['bio'])).map((r) => r.name),
    ['丙'],
    '相关 EXISTS 整体留原位',
  );
  try {
    await db.sql('SELECT id FROM entries WHERE COUNT(*) > 1');
    t('WHERE 含聚合维持报错', false, '未报错');
  } catch (e) {
    t('WHERE 含聚合维持报错', /只能用于/.test(e.message), `消息: ${e.message}`);
  }
});

/* ---------- LIMIT 短路 / top-N / 原值键 ---------- */
section('LIMIT 短路 / top-N / 单键原值', async () => {
  const db = await seedDb();
  const all = await db.sql('SELECT title FROM entries');

  deepEq(await db.sql('SELECT title FROM entries LIMIT 3'), all.slice(0, 3), '单表 LIMIT 短路 = 全量切片');
  deepEq(await db.sql('SELECT title FROM entries LIMIT 3 OFFSET 2'), all.slice(2, 5), 'OFFSET + LIMIT');
  deepEq(await db.sql('SELECT title FROM entries LIMIT 0'), [], 'LIMIT 0');
  deepEq(await db.sql('SELECT title FROM entries LIMIT 100'), all, 'LIMIT 超总量');
  deepEq(
    await db.sql("SELECT title FROM entries WHERE cat = 'physics' LIMIT 2"),
    (await db.sql("SELECT title FROM entries WHERE cat = 'physics'")).slice(0, 2),
    '已下推谓词 + 短路',
  );
  deepEq(
    await db.sql("SELECT e.title, a.name FROM entries e JOIN authors a ON e.authorId = a.id WHERE a.level = 1 LIMIT 3"),
    (await db.sql("SELECT e.title, a.name FROM entries e JOIN authors a ON e.authorId = a.id WHERE a.level = 1")).slice(0, 3),
    'join + 右侧谓词(留原位)+ 短路',
  );
  deepEq(
    await db.sql('SELECT e.title FROM entries e LEFT JOIN authors a ON e.authorId = a.id LIMIT 4'),
    (await db.sql('SELECT e.title FROM entries e LEFT JOIN authors a ON e.authorId = a.id')).slice(0, 4),
    'left join 短路(null 扩展行照常计数)',
  );
  deepEq(
    await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id JOIN (SELECT id FROM authors WHERE level = 1) f ON f.id = a.id LIMIT 3'),
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id JOIN (SELECT id FROM authors WHERE level = 1) f ON f.id = a.id')).slice(0, 3),
    '三表链短路(仅末层短路)',
  );

  /* top-N = 全量排序后切片 */
  const sorted = await db.sql('SELECT title FROM entries ORDER BY views DESC, title');
  deepEq(await db.sql('SELECT title FROM entries ORDER BY views DESC, title LIMIT 3'), sorted.slice(0, 3), 'top-N 单键排序');
  deepEq(await db.sql('SELECT title FROM entries ORDER BY views DESC, title LIMIT 3 OFFSET 2'), sorted.slice(2, 5), 'top-N + OFFSET');
  deepEq(await db.sql('SELECT title FROM entries ORDER BY views DESC, title LIMIT 0'), [], 'top-N LIMIT 0');
  deepEq(await db.sql('SELECT title FROM entries ORDER BY views DESC, title LIMIT 100'), sorted, 'top-N 超总量(走全量排序)');
  deepEq(
    await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id ORDER BY a.name, e.views LIMIT 4'),
    (await db.sql('SELECT e.title FROM entries e JOIN authors a ON e.authorId = a.id ORDER BY a.name, e.views')).slice(0, 4),
    'join + 多键 top-N',
  );
  deepEq(
    (await db.sql('SELECT id FROM entries ORDER BY views DESC LIMIT 4')).map((r) => r.id).includes('e4'),
    false,
    '排序键为 null 的行恒排最后(top-N 不误入)',
  );

  /* 单键原值:类型不混、对象按 JSON 等值 */
  const kdb = await newDb('keys');
  await kdb.collection('l').insertMany([
    { id: 'l1', k: 1 }, { id: 'l2', k: '1' }, { id: 'l3', k: true },
    { id: 'l4', k: { a: 1 } }, { id: 'l5', k: { a: 1 } },
  ]);
  await kdb.collection('r').insertMany([
    { id: 'r1', k: 1 }, { id: 'r2', k: '1' }, { id: 'r3', k: true }, { id: 'r4', k: { a: 1 } },
  ]);
  deepEq(
    await kdb.sql('SELECT l.id AS lid, r.id AS rid FROM l JOIN r ON l.k = r.k ORDER BY lid, rid'),
    [
      { lid: 'l1', rid: 'r1' }, { lid: 'l2', rid: 'r2' }, { lid: 'l3', rid: 'r3' },
      { lid: 'l4', rid: 'r4' }, { lid: 'l5', rid: 'r4' },
    ],
    '原值键:数字/字符串/布尔不互混,对象 JSON 等值',
  );
  deepEq(
    await kdb.sql('SELECT l.id AS lid FROM l WHERE EXISTS (SELECT 1 FROM r WHERE r.k = l.k) ORDER BY lid'),
    [{ lid: 'l1' }, { lid: 'l2' }, { lid: 'l3' }, { lid: 'l4' }, { lid: 'l5' }],
    '原值键:相关 EXISTS 同一原语',
  );
  deepEq(
    (await kdb.sql('SELECT l.id AS lid FROM l WHERE l.k IN (SELECT k FROM r) ORDER BY lid')).length,
    5,
    '原值键:相关 IN 同一原语',
  );
});

/* ---------- 中文拼音序 / MATCH / INSTR / CASE ---------- */
section('拼音排序 / MATCH 全文 / INSTR / CASE', async () => {
  const db = await newDb('zh');
  await db.collection('p').insertMany([
    { id: 'z', name: '张三' }, { id: 'l', name: '李四' },
    { id: 'w', name: '王五' }, { id: 'c', name: '陈六' },
  ]);
  /* 码点序是 张<李<王<陈,拼音序应是 陈(chén)<李(lǐ)<王(wáng)<张(zhāng) */
  deepEq(
    (await db.sql('SELECT id FROM p ORDER BY name')).map((r) => r.id),
    ['c', 'l', 'w', 'z'],
    'ORDER BY 中文按拼音序',
  );
  deepEq(
    (await db.sql('SELECT id FROM p ORDER BY name DESC')).map((r) => r.id),
    ['z', 'w', 'l', 'c'],
    '拼音序 DESC',
  );
  deepEq(
    (await db.sql('SELECT COUNT(*) AS n FROM p WHERE name = ?', ['李四']))[0].n,
    1,
    '等值过滤仍按精确值(不受拼音影响)',
  );

  /* collation 选项:码点序 / 其他 locale;等值语义不变 */
  deepEq(
    (await db.sql('SELECT id FROM p ORDER BY name', [], { collation: '' })).map((r) => r.id),
    ['z', 'l', 'w', 'c'],
    'collation 空串 = 码点序(张李王陈)',
  );
  deepEq(
    (await db.sql('SELECT id FROM p ORDER BY name', [], { collation: 'en' })).map((r) => r.id),
    ['z', 'l', 'w', 'c'],
    "collation 'en' 不识拼音:中文按 en 默认权重(≈码点序),证明设置生效",
  );
  deepEq(
    (await db.sql('SELECT id FROM p ORDER BY name')).map((r) => r.id),
    ['c', 'l', 'w', 'z'],
    '缺省 collation 仍为 zh 拼音',
  );

  /* MATCH:空白分词全命中(AND)、大小写不敏感、免索引 */
  await db.collection('docs').insertMany([
    { id: 'd1', title: '浏览器历史与收藏', body: 'FireFox 式最近访问记录' },
    { id: 'd2', title: '邮件应用', body: '最近访问过的发件人' },
    { id: 'd3', title: 'null 正文', body: null },
  ]);
  deepEq(
    (await db.sql("SELECT id FROM docs WHERE body MATCH '最近 记录' ORDER BY id")).map((r) => r.id),
    ['d1'],
    'MATCH 多词全命中',
  );
  deepEq(
    (await db.sql("SELECT id FROM docs WHERE body MATCH 'firefox'")).map((r) => r.id),
    ['d1'],
    'MATCH 大小写不敏感',
  );
  deepEq(
    (await db.sql("SELECT id FROM docs WHERE title MATCH '应用'")).map((r) => r.id),
    ['d2'],
    'MATCH 中文词',
  );
  deepEq(
    (await db.sql("SELECT id FROM docs WHERE NOT (body MATCH '最近') ORDER BY id")).map((r) => r.id),
    [],
    'NOT MATCH(null 正文与双命中均不入选)',
  );
  deepEq(
    (await db.sql("SELECT id FROM docs WHERE body MATCH ''")).length,
    0,
    '空查询串不命中',
  );
  deepEq(
    await db.sql("SELECT INSTR(body, '访问') AS p, INSTR(body, '不存在') AS q, INSTR(body, null) AS n FROM docs WHERE id = 'd1'"),
    [{ p: 12, q: 0, n: null }],
    'INSTR 首现位置/未命中 0/null',
  );

  /* CASE:搜索式 / 简单式 / ELSE / 无 ELSE 得 null / 嵌套 */
  await db.collection('sc').insertMany([
    { id: 's1', score: 95 }, { id: 's2', score: 72 }, { id: 's3', score: 40 }, { id: 's4', score: null },
  ]);
  deepEq(
    await db.sql("SELECT id, CASE WHEN score >= 90 THEN '优' WHEN score >= 60 THEN '良' ELSE '差' END AS grade FROM sc ORDER BY id"),
    [{ id: 's1', grade: '优' }, { id: 's2', grade: '良' }, { id: 's3', grade: '差' }, { id: 's4', grade: '差' }],
    'CASE 搜索式(null 走 ELSE)',
  );
  deepEq(
    await db.sql("SELECT CASE score WHEN 95 THEN 'A' WHEN 72 THEN 'B' END AS g FROM sc ORDER BY id"),
    [{ g: 'A' }, { g: 'B' }, { g: null }, { g: null }],
    'CASE 简单式(无 ELSE 得 null,null 不等任何值)',
  );
  deepEq(
    (await db.sql("SELECT id FROM sc WHERE CASE WHEN score >= 60 THEN 1 ELSE 0 END = 1 ORDER BY id")).map((r) => r.id),
    ['s1', 's2'],
    'CASE 在 WHERE 中(单源可下推)',
  );
  deepEq(
    await db.sql("SELECT id, CASE WHEN score >= 90 THEN '高' ELSE CASE WHEN score >= 60 THEN '中' ELSE '低' END END AS tier FROM sc ORDER BY id"),
    [{ id: 's1', tier: '高' }, { id: 's2', tier: '中' }, { id: 's3', tier: '低' }, { id: 's4', tier: '低' }],
    'CASE 嵌套',
  );
  deepEq(
    (await db.sql("SELECT COUNT(*) AS n FROM sc GROUP BY CASE WHEN score >= 60 THEN '及格' ELSE '不及格' END ORDER BY n DESC")).map((r) => r.n),
    [2, 2],
    'CASE 在 GROUP BY(null 归 ELSE 分组)',
  );
  try {
    await db.sql('SELECT CASE FROM sc');
    t('CASE 缺 WHEN 报解析错误', false, '未报错');
  } catch (e) {
    t('CASE 缺 WHEN 报解析错误', /WHEN|解析/.test(e.message), `消息: ${e.message}`);
  }
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
    [{ name: '丙' }, { name: '甲' }, { name: '乙' }],
    '相关 EXISTS(hash 半连接,名字按拼音序)',
  );
  deepEq(
    await db.sql('SELECT a.name FROM authors a WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.authorId = a.id)'),
    [{ name: '丁' }],
    'NOT EXISTS(反连接)',
  );
  deepEq(
    await db.sql('SELECT a.name, (SELECT COUNT(*) FROM entries e WHERE e.authorId = a.id) AS n FROM authors a ORDER BY a.name'),
    [{ name: '丙', n: 3 }, { name: '丁', n: 0 }, { name: '甲', n: 4 }, { name: '乙', n: 2 }],
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
