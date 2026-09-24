# AetherWebDatabase

OPFS 分页文档数据库:4KB 固定页、双超级块原子提交、可选页级 AES-256-GCM、
每库操作串行、单条指令原子的集合 CRUD。零依赖 ESM,面向 AetherWebOS 应用。

## 能力边界(刻意维持)

**有**

- 一个「数据库文件」= OPFS 上的 `awdb/<name>.awdb`,固定 **4096B 页**
- page0/1 **双超级块**(CRC + generation),CoW 写脏页后翻转另一槽 → 单指令原子
- 多集合文档库:`insert / get / find / update / remove` 系列
- **页级** AES-256-GCM(每页独立 IV;PBKDF2 密钥 open 时派生一次并缓存)
- 文档可跨页(加密逻辑 chunk = 4068B;明文 = 4096B)
- 同名库句柄单例 + 每库 Promise 队列(同文件单线程;异库互不阻塞)
- 存储适配:默认 OPFS,测试注入 `createMemoryBackend()`

**没有(刻意)**

- B+树 / 二级索引 / 视图 / SQL
- 跨语句事务(仅单条指令原子)
- 多标签页协同

## 快速上手

```js
import { open } from 'aether-webdatabase';

// 浏览器默认 OPFS
const db = await open('sms');
// 加密(页级)
const secret = await open('journal', { password: 'user-pass' });
// Node / 测试
const test = await open('t', { storage: 'memory' });

const msgs = db.collection('messages');
const m = await msgs.insert({ from: '10086', text: '验证码 1234', date: Date.now() });
const list = await msgs.find({ from: '10086' }, { sort: { date: -1 }, limit: 20 });
await msgs.update(m.id, { read: true });
await msgs.remove(m.id);
```

## 文件格式

```
页 0  超级块槽 A(明文)
页 1  超级块槽 B(明文)
页 2+ 数据页
```

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

**目录 JSON:**

```json
{
  "free": [12, 15],
  "cols": {
    "messages": {
      "seq": 3,
      "docs": { "c1-…": { "p": [4, 5], "n": 5000 } }
    }
  }
}
```

`p` = 页号列表,`n` = 文档 UTF-8 字节长。

## 原子提交(CoW)

```
insert/update/remove
  → 备份目录 JSON
  → 分配页(free 或文件尾)并只写「旧超级块未引用」的页
  → 写新目录页
  → generation+1 写入另一超级块槽
  任一步失败 → 不翻槽,旧 generation 仍完整有效;内存回滚
```

删除/更新只把旧页放回 free(逻辑),**不**整库重加密;
新数据只写入 free/扩展区页。

## 加密

| 点 | 做法 |
|---|---|
| 粒度 | **每数据页独立** AES-256-GCM |
| IV | 每次写页随机 12B,存页首 |
| 密钥 | PBKDF2-SHA-256 × 150000,salt 在超级块;**open 派生一次缓存** |
| 超级块 | 始终明文(要读 salt/目录定位) |

删一行 ≠ 整库重加密:只改目录 + 该文档的页(新页从 free/尾部分配)。

## API 摘要

| 方法 | 说明 |
|---|---|
| `open(name, { password?, storage? })` | 打开;`storage`: `'opfs'`(默认)/ `'memory'` / 自定义后端 |
| `db.collection(name)` | 集合句柄 |
| `col.insert / insertMany / get / find / findOne / count` | 增查 |
| `col.update / updateWhere / remove / removeWhere / clear` | 改删 |
| `db.exportJSON() / importJSON(json)` | 含文档体的整库导出/导入 |
| `db.setPassword(p \| null)` | 换密 / 转明文(紧凑重写) |
| `db.drop() / close()` | 删库 / 关句柄 |
| `createMemoryBackend()` | 测试后端(`failWrites` 可模拟写失败) |

读写返回值均为深拷贝。

## 测试

```bash
node test/db-test.mjs
# 或 npm test
```

Node 无 OPFS,测试全走 memory 后端;页格式与提交协议与 OPFS 相同。

## License

MIT
