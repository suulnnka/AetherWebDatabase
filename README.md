# AetherWebDatabase

Web 文件型文档数据库:整库 JSON 落盘、可选 AES-256-GCM 加密、每库操作串行、
单条指令原子的集合 CRUD。零依赖、ESM,面向 AetherWebOS 应用(短信 / 邮件 / 日记等)的轻量持久层。

## 能力边界(刻意维持)

**有**

- 一个「数据库文件」= 一条存储记录(`awdb.<name>`),内容为整库 JSON
- 多集合文档库:`insert / get / find / update / remove` 系列
- 整库可选加密(AES-256-GCM,PBKDF2-SHA-256 × 150000 派生)
- 同名库句柄单例 + 每库 Promise 队列串行(同文件单线程;异库互不阻塞)
- 单条指令原子:变更前备份 → 同步改内存 → 序列化/加密/落盘;失败回滚
- 存储适配可注入(默认 `localStorage`,测试用 `memoryStorage`)

**没有(刻意)**

- 视图、索引、联表
- 跨语句事务(仅单条指令原子)
- 多标签页 / 多进程协同(单 JS 上下文内保证)
- SQL

## 安装 / 引用

仓库即包:`aether-webdatabase`(ESM)。webos 以 `vendor/AetherWebDatabase` 子模块引用:

```js
import { open } from '../../vendor/AetherWebDatabase/src/index.js';
// 或包名(若已 link): import { open } from 'aether-webdatabase';
```

## 快速上手

```js
import { open } from 'aether-webdatabase';

// 明文库
const db = await open('sms');

// 加密库(整库 AWDB1:* 落盘)
const secret = await open('journal', { password: 'user-pass' });

const msgs = db.collection('messages');

// 增
const m = await msgs.insert({ from: '10086', text: '验证码 1234', date: Date.now() });
// m.id 已自动生成;也可传 { id: '显式', ... }

// 查
const list = await msgs.find({ from: '10086' }, { sort: { date: -1 }, limit: 20 });
const one = await msgs.findOne((d) => d.text.includes('1234'));
const n = await msgs.count({ from: '10086' });

// 改
await msgs.update(m.id, { read: true });
await msgs.updateWhere({ read: false }, { read: true });

// 删
await msgs.remove(m.id);
await msgs.removeWhere({ from: '10086' });
```

## API

### `open(name, opts?) → Promise<Database>`

| 参数 | 说明 |
|---|---|
| `name` | 库名,对应存储键 `awdb.<name>` |
| `opts.password` | 加密密码;已有明文库传密码会**自动升级**为加密 |
| `opts.storage` | 存储适配,默认 `localStorage` |

同 `storage` + 同 `name` 并发 `open` 返回**同一句柄**。已用密码 A 打开时再传 B 会抛错。
加密库无密码 / 密码错误时 `open` 抛错。

### `Database`

| 方法 | 说明 |
|---|---|
| `collection(name)` | 集合句柄(首次写入才建壳) |
| `listCollections()` | 已有集合名列表 |
| `dropCollection(name)` | 删集合 |
| `setPassword(p \| null)` | 换密 / 转明文 |
| `exportJSON()` / `importJSON(json)` | 整库导出(明文)/ 导入(覆盖) |
| `drop()` | 删库文件并关闭句柄 |
| `close()` | 关闭句柄(不删文件) |
| `encrypted` / `closed` / `name` | 状态 |

### `Collection`

| 方法 | 说明 |
|---|---|
| `insert(doc)` | 插入;`doc.id` 已存在抛错;返回带 id 副本 |
| `insertMany(docs)` | 批量;全部成功或全部回滚 |
| `get(id)` | 按 id;无 → `null` |
| `find(filter?, opts?)` | `filter` 函数或平面对象;`opts: { sort, limit, offset }` |
| `findOne(filter?)` | 第一条 |
| `count(filter?)` | 计数 |
| `update(id, patch)` | 浅合并;不可改 id;无 → `null` |
| `updateWhere(filter, patch)` | 批量浅合并;返回条数 |
| `remove(id)` / `removeWhere(filter)` | 删除 |
| `clear()` | 清空集合 |

读写返回值均为**深拷贝**,外部改动不会污染库内状态。

### 存储适配

```js
import { memoryStorage, localAdapter, storageKey } from 'aether-webdatabase';

const mem = memoryStorage();           // 测试用;mem.failWrites = true 可模拟写失败
const db = await open('t', { storage: mem });
// 自定义: { getItem(k), setItem(k, v), removeItem(k) } 同步三件套即可
```

### 加密格式

```
AWDB1:<base64(salt16)>:<base64(iv12)>:<base64(ciphertext)>
```

- 密钥:PBKDF2-SHA-256,150000 次迭代,AES-GCM-256
- 每次写盘随机 salt/IV
- 与 AetherWebOS `WEOS1` 文件加密同构,前缀区分

明文库直接存 JSON(以 `{` 开头),两种格式靠前缀区分。

## 原子性与并发

```
open('sms') ──► 单例句柄 + 每库串行队列
                    │
                    ▼
              insert/update/... ──► 备份 JSON ──► 改内存 ──► 加密+setItem
                                                    │ fail
                                                    ▼
                                               内存回滚备份
```

- **同库**全部操作(含读)进同一队列,不会交错改盘
- **异库**并行,互不等待
- 仅单条指令原子;`insertMany` 算一条指令(全成或全败)
- 无跨语句事务

## 测试

```bash
node test/db-test.mjs
# 或 npm test
```

## License

MIT
