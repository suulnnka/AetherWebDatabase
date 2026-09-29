# AetherWebDatabase

分页文档数据库:4KB 固定页、双超级块原子提交、可选页级 AES-256-GCM、
每库操作串行、单条指令原子的集合 CRUD、写入校验的集合 schema(可自动演化)、
物化内存执行的只读 SQL SELECT。零依赖 ESM。

**经宿主 `fs` 托管的随机读写**:宿主实现 `readAt` / `writeAt` / `fileSize` 时,
只读写脏页(不整库缓冲);否则退回整文件 read/write。**不直连 OPFS**;
webos 生产路径 `createFileBackend` → `/home/<user>/appdata/<app>.awdb`。

## 能力边界(刻意维持)

**有**

- 一个「数据库文件」= **带 `.awdb` 扩展名**的文件,固定 **4096B 页**
- page0/1 **双超级块**(CRC + generation),CoW 写脏页后翻转另一槽 → 单指令原子
- 多集合文档库:`insert / get / find / update / remove` 系列
- **页级** AES-256-GCM(每页独立 IV;PBKDF2 密钥 open 时派生一次并缓存)
- 文档可跨页(加密逻辑 chunk = 4068B;明文 = 4096B)
- 同名库句柄单例 + 每库 Promise 队列(同文件单线程;异库互不阻塞)
- 存储:`createFileBackend(fs, path)`(优先 `fs.readAt/writeAt` 随机页)/ `createMemoryBackend()` / 自定义
- **schema**:strict 校验(类型/必填/默认值/未知字段策略)与 auto 演化
  (未知字段自动吸收、类型放宽,与写入同事务原子落盘)
- **只读 SQL SELECT**:物化内存执行,支持 JOIN / GROUP BY / 子查询(见下)
- **集合物化 `loadAll()`**:SQL 数据源;只读永久缓存,写该集合即失效

**没有(刻意)**

- **直连 OPFS / IndexedDB / 任何宿主私有存储**
- B+树 / 二级索引(等值检索靠物化后的 hash 原语)
- SQL 的 DML / DDL / 子查询外的 LATERAL / 窗口函数 / CTE
- 跨语句事务(仅单条指令原子)
- 多标签页协同

## 快速上手

```js
import { open, createFileBackend, createMemoryBackend } from 'aether-webdatabase';

// 宿主提供字符串文件系统(webos 的 ctx.fs / Node 模拟 FS)
const backend = createFileBackend(vfs, '/home/user/appdata/sms.awdb', { as: 'user' });
const db = await open('sms', { storage: backend, password: '…' });

// 纯内存(测试)
const mem = await open('t', { storage: createMemoryBackend() });
// 或 storage 省略时默认 memory
const m2 = await open('t2');
```

## 文件格式

库文件名建议带 **`.awdb`** 扩展名(如 `sms.awdb`)。内容为**原始字节**(4KB 页拼接),**不再 base64 包装**;旧 `AWDBVFS1:<base64>` 文件读取时自动解码。

```
页 0  超级块槽 A(明文)
页 1  超级块槽 B(明文)
页 2+ 数据页
```

经宿主文件系统落盘时即为该字节序列(如 OPFS `fsdata/…/sms.awdb`)。

超级块字段(64B + 零填充到 4096):

| 偏移 | 宽度 | 字段 |
|---|---|---|
| 0 | 8 | magic `AWDBPG01` |
| 8 | 4 | version |
| 12 | 4 | pageSize (=4096) |
| 16 | 4 | chunkSize |
| 20 | 4 | generation |
| 24 | 1 | encrypted |
| 28 | 16 | salt(PBKDF2) |
| 44 | 4 | catalogStart |
| 48 | 4 | catalogPages |
| 52 | 4 | catalogByteLen |
| 56 | 4 | pageCount |
| 60 | 4 | CRC32(bytes[0..59]) |

**数据页(加密):** `[IV 12B][AES-GCM(pad(logical, 4068)) → cipher‖tag]` 恰好 4096B。  
**数据页(明文):** 逻辑载荷零填充到 4096B。

**目录 JSON:** `p` = 页号列表,`n` = 文档 UTF-8 字节长。

## 原子提交(CoW)

```
insert/update/remove
  → 备份目录 JSON
  → 分配页(free 或文件尾)并只写「旧超级块未引用」的页
  → 写新目录页
  → generation+1 写入另一超级块槽
  任一步失败 → 不翻槽,旧 generation 仍完整有效;内存回滚
```

CoW 只写脏页:宿主有 `readAt`/`writeAt` 时按页偏移随机写(`writePages` → `fs.writeAt`);
无随机 API 时退回整文件缓冲回写。

## 加密

| 点 | 做法 |
|---|---|
| 粒度 | **每数据页独立** AES-256-GCM |
| IV | 每次写页随机 12B,存页首 |
| 密钥 | PBKDF2-SHA-256 × 150000,salt 在超级块;**open 派生一次缓存** |
| 超级块 | 始终明文(要读 salt/目录定位) |

## Schema(集合级字段声明)

schema 挂在集合元数据上,随目录双超级块**原子落盘**;四个写入口
(`insert / insertMany / update / updateWhere`)统一走校验管线。

```js
const col = await db.createCollection('entries', {
  mode: 'auto',                          // 'strict'(默认)| 'auto'
  schema: {
    title: { type: 'string', required: true },
    views: { type: 'number', default: 0 },
    tags:  { type: 'array', items: 'string' },
    note:  'string',                     // 简写
  },
  extra: 'reject',                       // strict 未知字段:reject | allow | strip
});
```

类型为 `string / number / boolean / object / array`,**声明不含 null**:
非必填字段一律隐式可空,`required` 字段不得为 `null`(缺键或值 null 均报错)。

- **strict**:类型 / 必填 / 元素类型校验,未知字段按 `extra` 处理,失败即回滚;
- **auto**(自动演化):写入遇到未知字段**按值推断并入 schema**(可选字段;
  吸收时值为 null 的字段类型未知,首见实际值时学习);类型不匹配、
  数组元素类型冲突、required 字段 null **直接报错回滚**——不放宽为联合
  类型、不放弃元素约束;演化与写入同事务原子落盘(失败时吸收一并撤销);
  `required` / `default` 仍生效;
- `col.setSchema(fields, { scan })`:宽松替换(strict 默认先扫存量校验,
  等价 ALTER TABLE ADD COLUMN);`fields` 传 `null` 移除 schema;
- `col.migrateSchema({ fields, version, run })`:破坏性变更 —— 单事务内
  全量重读 → `run(doc)` 逐文档变换 → 按新 schema 校验 → 紧凑重写,
  失败整体回滚;版本记入 `schemaV`,open 时**绝不自动迁移**。

## SQL(只读 SELECT,物化内存执行)

```js
const rows = await db.sql(
  'SELECT e.title, a.name, (SELECT COUNT(*) FROM entries x WHERE x.authorId = a.id) AS n ' +
  'FROM entries e JOIN authors a ON e.authorId = a.id WHERE e.cat = ? ORDER BY n DESC LIMIT 100',
  ['physics'],
);
```

- 执行模型:parse → AST → 编译为 JS 闭包(不用 `new Function`,CSP 安全);
  首查自动 `loadAll()` 物化(只读缓存永久有效,写该集合即失效),
  之后 filter / sort / hash join 全在内存数组上,谓词遵循 SQL 三值逻辑;
- 支持:`DISTINCT` / 投影别名 / `INNER|LEFT JOIN`(等值,可 AND 多键)/
  `WHERE`(比较、AND/OR/NOT、IN、BETWEEN、LIKE、IS NULL)/
  `GROUP BY + HAVING` / 聚合(`COUNT(*|x|DISTINCT x)`、SUM/AVG/MIN/MAX)/
  `ORDER BY` 多键(ASC/DESC,**null 恒最后**)/ `LIMIT OFFSET`;
  标量函数 LOWER/UPPER/LENGTH/ABS/ROUND/COALESCE;`?` 参数绑定;
- 子查询:FROM 派生表、非相关 IN/EXISTS/标量(执行一次缓存)、
  **等值相关** EXISTS/IN/标量聚合(hash 化为 Set/Map,不逐行重跑);
- 明确不支持(报错):非等值相关、相关 NOT IN(NULL 语义陷阱)、
  相关子查询内 JOIN、LATERAL、聚合嵌套;相关子查询的关联列
  **必须带直接外层表的别名前缀**;裸列(无前缀)按源序取第一个含该字段的源;
- `SELECT *` 输出与物化共享嵌套对象 —— **结果约定只读**,修改请走 update。

参考量级(内存后端、明文、5 万行 × 1 千行):
首查物化 ~330ms(其后热查 ~9ms)、JOIN ~55ms、GROUP BY ~32ms、
相关标量子查询 ~33ms。

## API 摘要

| 方法 | 说明 |
|---|---|
| `open(name, { password?, storage? })` | 打开;`storage` 必须是注入后端或 `'memory'`(默认) |
| `createFileBackend(fs, path, opts?)` | 文件后端:优先 `readAt`/`writeAt` 随机页,否则整文件 |
| `createMemoryBackend()` | 内存后端(`failWrites` 模拟写失败) |
| `db.collection(name)` | 集合句柄 |
| `db.createCollection(name, { schema?, mode?, extra? })` | 建集合(幂等,带 schema) |
| `col.insert / insertMany / get / find / findOne / count` | 增查(经 schema 管线) |
| `col.update / updateWhere / remove / removeWhere / clear` | 改删 |
| `col.setSchema(fields, opts?) / col.migrateSchema({...})` | schema 替换 / 迁移 |
| `col.loadAll()` | 整集合物化(SQL 数据源;也可预热) |
| `db.sql(text, params?)` | 只读 SELECT(首查自动物化) |
| `db.exportJSON() / importJSON(json)` | 含文档体的整库导出/导入 |
| `db.setPassword(p \| null)` | 换密 / 转明文(紧凑重写) |
| `db.drop() / close()` | 删库 / 关句柄 |

读写返回值均为深拷贝(SQL 结果与 `loadAll()` 数组除外 —— 约定只读)。

## 测试(Node 模拟 webos FS)

```bash
node test/db-test.mjs      # CRUD / 原子回滚 / 加密 / 单例串行
node test/schema-test.mjs  # schema 校验 / auto 演化 / 迁移 / 物化失效
node test/sql-test.mjs     # SQL 查询 / join / 子查询 / 5 万条基准
# 或 npm test
```

测试不依赖 OPFS:`test/mock-webos-fs.mjs` 对齐 webos `fs.js`（inode 拆分 + **`readAt`/`writeAt` 随机读写**），
主用例经 `createFileBackend` 走 `file-at` 后端（只写脏页,不整库回写）。

## License

MIT
