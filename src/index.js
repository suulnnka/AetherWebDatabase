/* ============================================================
 * AetherWebDatabase —— Web 文件型文档数据库(独立仓库,webos 子模块引用)
 *
 * 面向 webos 应用(短信 / 邮件 / 日记等)的轻量持久层:
 *   · 数据整库落一条存储记录(localStorage 或注入适配),格式为 JSON;
 *   · 可选整库 AES-256-GCM 加密(PBKDF2 派生);
 *   · 同名库句柄单例 + 每库操作串行 —— 「一个数据库文件 = 单线程」;
 *   · 仅集合级 CRUD,单条指令原子(失败回滚),无视图、无跨语句事务。
 * ============================================================ */

export { open, Database, Collection, closeAll } from './database.js';
export { memoryStorage, localAdapter, storageKey } from './storage.js';
export { encryptText, decryptText, isEncrypted, cryptoDb } from './crypto.js';

import { open, Database, Collection, closeAll } from './database.js';
import { memoryStorage, localAdapter, storageKey } from './storage.js';
import { encryptText, decryptText, isEncrypted, cryptoDb } from './crypto.js';

const AetherWebDatabase = {
  open,
  Database,
  Collection,
  closeAll,
  memoryStorage,
  localAdapter,
  storageKey,
  encryptText,
  decryptText,
  isEncrypted,
  cryptoDb,
};

export default AetherWebDatabase;
